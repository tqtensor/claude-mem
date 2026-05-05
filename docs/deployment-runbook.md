# Kubernetes Deployment Runbook

How to deploy claude-mem to a Kubernetes cluster (validated against Nebius; works on any cluster with nginx-ingress + cert-manager).

This runbook covers the **shippable path today**: SQLite mode behind a Helm chart, with API-key auth and TLS ingress. PostgreSQL mode is **not** yet wired through `SessionStore`, so `database.type=postgres` will not work end-to-end until Phase 2 of `docs/team-k8s-plan.md` is finished. See [Limitations](#limitations).

---

## What gets deployed

```
Developer machine (Claude Code)
  └─ claude-mem hooks
       └─ HTTPS → cert-manager TLS → nginx Ingress
                                      └─ claude-mem worker Pod (SQLite + PVC)
                                           └─ Chroma Pod (vector search, optional)
```

Single replica by design. The worker holds in-process state (rate limits, restart guard, branch manager, search caches, SSE broadcasters); horizontal scaling needs Redis + leader election and is out of scope for v1.

---

## Prerequisites

### Cluster

- Kubernetes ≥ 1.27
- nginx-ingress controller installed
- cert-manager installed with a `ClusterIssuer` pointing at Let's Encrypt (or your CA)
- A `StorageClass` that supports `ReadWriteOnce` (any block-storage class — Nebius `csi-nebius` works). **Do not** use NFS-backed storage for SQLite — WAL mode is incompatible with NFS.
- A DNS record for the worker (e.g. `mem.company.com`) pointing at the nginx ingress IP.

### Local

- `kubectl` configured for the target cluster
- `helm` ≥ 3.12
- `docker` with buildx
- `bun` ≥ 1.2 and `node` ≥ 20
- `gh` (for GHCR auth) or whatever credentials your registry needs
- `jq`, `openssl`

### One-time cluster setup

```bash
# nginx-ingress
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm upgrade -i ingress-nginx ingress-nginx/ingress-nginx \
  -n ingress-nginx --create-namespace

# cert-manager
helm repo add jetstack https://charts.jetstack.io
helm upgrade -i cert-manager jetstack/cert-manager \
  -n cert-manager --create-namespace --set installCRDs=true

# ClusterIssuer (Let's Encrypt prod, HTTP-01 challenge)
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@company.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: nginx
EOF
```

Get the ingress public IP and create the DNS record before the chart install — TLS issuance fails without it.

```bash
kubectl -n ingress-nginx get svc ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

---

## 1. Build and push the image

The Dockerfile copies pre-built artifacts (`plugin/scripts/worker-service.cjs`), so the build step **must** run locally before `docker build`.

```bash
cd <repo-root>
npm install
npm run build

docker buildx create --use --name claude-mem-builder 2>/dev/null || true

# GHCR (recommended for public/internal)
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <your-gh-user> --password-stdin
docker buildx build \
  --platform linux/amd64 \
  -t ghcr.io/<your-gh-user>/claude-mem:v0.1.0 \
  --push .

# OR Nebius container registry
# docker login cr.nemax.nebius.cloud
# docker buildx build --platform linux/amd64 \
#   -t cr.nemax.nebius.cloud/<project>/claude-mem:v0.1.0 --push .
```

The chart defaults to `linux/amd64`. Multi-arch (`linux/amd64,linux/arm64`) is supported but doubles build time; only use it if you have ARM nodes.

---

## 2. Generate API keys

One key per developer. Distribute out-of-band.

```bash
ALICE_KEY=$(openssl rand -hex 32)
BOB_KEY=$(openssl rand -hex 32)
echo "alice: $ALICE_KEY"
echo "bob:   $BOB_KEY"
```

Store these in your password manager — they're never recoverable from the cluster (only their SHA-256 hashes are kept in memory at runtime).

---

## 3. Install the chart

```bash
cd <repo-root>

# Pull bitnami postgres subchart locally (gitignored after fetch)
helm dependency update helm/claude-mem/

kubectl create namespace claude-mem || true

helm upgrade -i claude-mem helm/claude-mem/ \
  -n claude-mem \
  --set image.repository=ghcr.io/<your-gh-user>/claude-mem \
  --set image.tag=v0.1.0 \
  --set database.type=sqlite \
  --set postgresql.enabled=false \
  --set "auth.keys.alice=$ALICE_KEY" \
  --set "auth.keys.bob=$BOB_KEY" \
  --set "ingress.hosts[0].host=mem.company.com" \
  --set "ingress.hosts[0].paths[0].path=/" \
  --set "ingress.hosts[0].paths[0].pathType=Prefix" \
  --set "ingress.tls[0].secretName=claude-mem-tls" \
  --set "ingress.tls[0].hosts[0]=mem.company.com"
```

For private registries, also pass `--set imagePullSecrets[0].name=<your-secret>`.

### Why `database.type=sqlite`

The worker still calls `SessionStore.ts` directly via `bun:sqlite` — the SessionStore async sweep is incomplete. Until that lands, **do not** set `database.type=postgres` even though the chart accepts the value: the worker will start but observations will not be written.

---

## 4. Verify

```bash
kubectl -n claude-mem rollout status deploy/claude-mem --timeout=300s
kubectl -n claude-mem get pods,svc,ingress
kubectl -n claude-mem logs deploy/claude-mem --tail=50
```

Expected during boot:
```
[SETTINGS] Created settings file with defaults: /data/settings.json
HTTP server started host=0.0.0.0 port=37777 pid=1
AUTH | API key auth enabled users=2 rpm=60
```

### Health checks

The startup probe waits up to 5 minutes (60 × 5s); cert-manager issuance can take a few minutes. If TLS isn't ready yet, hit the pod directly first:

```bash
# Direct pod check (no TLS, no auth on probe path)
kubectl -n claude-mem port-forward deploy/claude-mem 37777:37777 &
curl -fsS http://localhost:37777/api/health
# {"status":"ok"}     ← auth enabled → minimal payload on probe
```

Once TLS is ready:
```bash
curl -fsS https://mem.company.com/api/health
# {"status":"ok"}

curl -fsS -H "Authorization: Bearer $ALICE_KEY" https://mem.company.com/api/health
# Full payload: version, uptime, pid, ai status, ...

curl -i https://mem.company.com/api/version
# HTTP/2 401   ← /api/version requires auth, by design

curl -i -H "Authorization: Bearer wrong" https://mem.company.com/api/data
# HTTP/2 401
```

---

## 5. Wire local Claude Code to the cluster

Each developer runs:

```bash
chmod +x scripts/team-setup.sh
scripts/team-setup.sh \
  --url https://mem.company.com \
  --key <their-personal-key>
```

Then restart Claude Code. Watch hooks call into the cluster:

```bash
kubectl -n claude-mem logs -f deploy/claude-mem
```

Expected: `→ POST /api/observations`, `→ POST /api/init`, etc., with `200 OK` responses.

---

## 6. Operations

### View logs

```bash
kubectl -n claude-mem logs -f deploy/claude-mem
kubectl -n claude-mem logs deploy/claude-mem --tail=200 --since=1h
```

### Restart the worker

```bash
kubectl -n claude-mem rollout restart deploy/claude-mem
```

The worker holds in-process state, so rolling restart is a brief outage (typically 30–90s). Hooks fall back to "remote worker unreachable" exit-1 warnings during that window.

### Rotate an API key

```bash
NEW_KEY=$(openssl rand -hex 32)

helm upgrade --reuse-values -n claude-mem claude-mem helm/claude-mem/ \
  --set "auth.keys.alice=$NEW_KEY"

# The deployment rolls; the user reconfigures via team-setup.sh
```

### Add a new user

```bash
NEW_KEY=$(openssl rand -hex 32)

helm upgrade --reuse-values -n claude-mem claude-mem helm/claude-mem/ \
  --set "auth.keys.carol=$NEW_KEY"
```

### Inspect the SQLite database

```bash
kubectl -n claude-mem exec -it deploy/claude-mem -- \
  sh -c 'apk add --no-cache sqlite || true; sqlite3 /data/claude-mem.db'
```

(Alpine images ship without `sqlite` — the `apk add` works only if the pod has internet access; otherwise `kubectl cp` the DB out and inspect locally.)

### Snapshot the SQLite database

```bash
kubectl -n claude-mem cp \
  $(kubectl -n claude-mem get pod -l app.kubernetes.io/name=claude-mem -o name | head -1):/data/claude-mem.db \
  /tmp/claude-mem-$(date -u +%Y%m%dT%H%M%SZ).db
```

The CronJob backup template (`templates/cronjob-backup.yaml`) only runs against PostgreSQL, so SQLite snapshots are operator-driven.

---

## 7. Upgrading the image

```bash
# After building & pushing a new tag:
helm upgrade --reuse-values -n claude-mem claude-mem helm/claude-mem/ \
  --set image.tag=v0.2.0
```

The data PVC survives the rolling restart. Migrations run on boot (`MigrationRunner` in `src/services/sqlite/migrations/runner.ts`).

---

## 8. Troubleshooting

### `helm install` fails with `chart dependency missing`

Run `helm dependency update helm/claude-mem/` first. The bitnami `postgresql` subchart tarball is gitignored and must be fetched per-checkout.

### Pod stuck in `CrashLoopBackOff`

```bash
kubectl -n claude-mem logs deploy/claude-mem --previous --tail=200
```

Common causes:
- `chroma-mcp` failing to start: set `--set chroma.enabled=false` and reinstall — chart still works without semantic search.
- PVC bound to a `ReadWriteMany` (NFS) volume: SQLite WAL needs `ReadWriteOnce` block storage. Recreate PVC with a different `storageClass`.

### TLS certificate stuck in `Pending`

```bash
kubectl -n claude-mem describe certificate claude-mem-tls
kubectl -n cert-manager logs deploy/cert-manager --tail=100
```

Most common: DNS not pointing at the ingress IP yet, or the HTTP-01 challenge can't reach the cluster (firewall on the LB).

### Hooks getting 401

Verify the developer's settings:
```bash
cat ~/.claude-mem/settings.json | jq '.CLAUDE_MEM_REMOTE_URL, .CLAUDE_MEM_API_KEY'
```

Confirm the key is in `auth.keys` (compare hashes is the safe way; just rotating is faster):
```bash
helm get values -n claude-mem claude-mem | grep -A20 auth
```

### Hooks getting 429

Per-IP rate limit (default 60/min). For a NAT'd team behind one egress IP, raise it:
```bash
helm upgrade --reuse-values -n claude-mem claude-mem helm/claude-mem/ \
  --set auth.rateLimitRpm=600
```

### "remote worker unreachable" warnings on the developer machine

The hook layer fail-closes when the worker is down — this is intentional, not a regression. Check:
```bash
curl -fsS https://mem.company.com/api/health
kubectl -n claude-mem get pods
```

### Migrations fail on upgrade

```bash
kubectl -n claude-mem logs deploy/claude-mem --tail=200 | grep -i migration
```

If the pod crashloops on startup-migration:
1. Snapshot the PVC (`kubectl cp` the DB out).
2. Roll back to the prior image tag.
3. File an issue with the migration version + error.

---

## 9. Teardown

```bash
helm uninstall claude-mem -n claude-mem
kubectl delete namespace claude-mem      # also deletes PVCs and Chroma data
```

To preserve data while removing the deployment:
```bash
helm uninstall claude-mem -n claude-mem
# Namespace + PVCs remain. Reinstalling reuses the same /data volume.
```

---

## Limitations

These are real today; track them before promising users anything beyond the documented path.

| Limitation                                                                 | Owner                                                                           | Tracked                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `database.type=postgres` does not work end-to-end                          | SessionStore.ts (247 sync `bun:sqlite` sites) needs async conversion            | `docs/team-k8s-plan.md` Phase 2 (partial) + Phase 3        |
| No horizontal scaling (`replicas: 1` hardcoded)                            | Worker holds in-process state (rate limits, branch manager, SSE, search caches) | Future phase: externalize state to Redis + leader election |
| Local SQLite history not migrated to team server                           | New users start with an empty server view of the cluster                        | Out of scope for v1                                        |
| Chroma collection is single-tenant (no per-user isolation in vector store) | `ChromaSync.ts` writes lack `user_id` metadata                                  | `docs/team-k8s-plan.md` Phase 4                            |
| Backup CronJob only supports PostgreSQL                                    | SQLite snapshotting is operator-driven (`kubectl cp`)                           | Acceptable; revisit if SQLite mode persists long-term      |

---

## Reference: chart values matrix

| Value                   | Default                         | Notes                                                               |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------- |
| `image.repository`      | `ghcr.io/thedotmack/claude-mem` | Override for your registry                                          |
| `image.tag`             | `""` (uses `Chart.AppVersion`)  | Pin in production                                                   |
| `worker.port`           | `37777`                         | Drives container, service, probes — single source of truth          |
| `database.type`         | `postgres`                      | **Set to `sqlite`** until Phase 2 lands                             |
| `database.sqlite.size`  | `10Gi`                          | Resize the PVC manually if needed; cannot shrink                    |
| `auth.keys`             | `{}`                            | Map of `username → key`. **Empty = unauthenticated worker**         |
| `auth.rateLimitRpm`     | `60`                            | Per-IP requests/minute                                              |
| `chroma.enabled`        | `true`                          | Set false if Chroma pod misbehaves; worker keeps working without it |
| `ingress.hosts[0].host` | `mem.example.com`               | Replace with your domain                                            |
| `backup.enabled`        | `false`                         | Postgres-only; opt-in                                               |
| `postgresql.enabled`    | `true`                          | Set false to bring your own Postgres or run sqlite mode             |

Defaults live in `helm/claude-mem/values.yaml`.
