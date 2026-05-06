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
- TLS for the worker: either cert-manager + a Let's Encrypt `ClusterIssuer`, **or** a Cloudflare Origin CA certificate written into a `kubernetes.io/tls` secret in the worker's namespace (validated path — see [Cloudflare Origin CA alternative](#cloudflare-origin-ca-alternative))
- A `StorageClass` that supports `ReadWriteOnce` (any block-storage class — Nebius `csi-nebius` works). **Do not** use NFS-backed storage for SQLite — WAL mode is incompatible with NFS. Postgres + Chroma on NFS works in practice (validated on Nebius `nfs-dns`).
- A DNS record for the worker (e.g. `mem.company.com`) pointing at the nginx ingress IP. With Cloudflare proxying, an `A` record (proxied) on the apex/sub-domain works.

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

### Cloudflare Origin CA alternative

If your zone is on Cloudflare and you'd rather not run cert-manager, you can issue a 15-year Origin CA cert and let Cloudflare terminate TLS at the edge:

1. Create a proxied `A` record pointing the worker hostname at the nginx ingress IP (or any reachable IP — Cloudflare proxies it).
2. Mint a Cloudflare Origin CA certificate for the hostname (one private key + CSR + `cloudflare.OriginCaCertificate`). The result is a `tls.crt` / `tls.key` pair valid only between Cloudflare and your origin.
3. Create a `kubernetes.io/tls` secret in the `claude-mem` namespace with that pair (e.g. `memory-tls-secret`) and reference it from `ingress.tls[0].secretName`.
4. **Drop the `cert-manager.io/cluster-issuer` annotation** in `ingress.annotations` — it triggers cert-manager to provision a competing cert. Override `ingress.annotations` with just nginx-relevant entries.

Validated against this Pulumi snippet (Python):

```python
from resources.cloudflare.tls.utils import create_origin_ca_cert  # local helper

memory_dns = cloudflare.DnsRecord(..., name="memory", type="A", content=nginx_ip, proxied=True)
memory_cert_bundle = create_origin_ca_cert(host=memory_dns)  # → (OriginCaCertificate, PrivateKey)

k8s.core.v1.Secret(
    "memory_tls_secret",
    metadata={"name": "memory-tls-secret", "namespace": "claude-mem"},
    type="kubernetes.io/tls",
    data=Output.all(
        memory_cert_bundle[0].certificate,
        memory_cert_bundle[1].private_key_pem,
    ).apply(lambda args: encode_tls_secret_data(args[0], args[1])),
)
```

Set Cloudflare's SSL/TLS mode to **Full (strict)** for the zone so it actually validates the origin cert.

---

## 1. Build and push the image

The Dockerfile copies pre-built artifacts (`plugin/scripts/worker-service.cjs`), so the build step **must** run locally before `docker build`.

> **Heads-up — Dockerfile is currently incomplete.** The shipped Dockerfile only copies `plugin/scripts/worker-service.cjs` and `plugin/package.json`, which is enough for the binary to start but **not** to initialize. The bundled worker resolves plugin assets relative to its own dirname's parent (`getPackageRoot() = /app/.. = /`), so it expects `/modes`, `/ui`, `/skills`, `/plugin/.mcp.json`, and `/package.json` at the image root. Without them you'll see the worker bind to port 37777 and then `Background initialization failed: Critical: code.json mode file missing`, returning 503 on `/api/readiness` forever.
>
> Add this to the Dockerfile before the `USER 1000` line until upstream fixes it:
>
> ```dockerfile
> COPY plugin/modes /modes
> COPY plugin/ui /ui
> COPY plugin/skills /skills
> COPY plugin/.mcp.json /plugin/.mcp.json
> COPY plugin/package.json /package.json
> ```
>
> **Also**: the image's default `CMD ["bun", "worker-service.cjs", "start"]` is wrong for Kubernetes. The `start` subcommand spawns a daemon child process and exits with code 0, which K8s reads as `Completed` and restarts forever. The HTTP server actually runs under the default/`--daemon` case. Either rebake the image with `CMD ["bun", "worker-service.cjs", "--daemon"]`, **or** override at deploy time via the chart (see [§3](#3-install-the-chart)).

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
  --set "ingress.tls[0].hosts[0]=mem.company.com" \
  --set "worker.command={bun,worker-service.cjs,--daemon}"
```

For private registries, also pass `--set imagePullSecrets[0].name=<your-secret>`.

> **`worker.command` override is required** until the Dockerfile's `CMD` is fixed upstream (see [§1](#1-build-and-push-the-image)). The chart's `templates/deployment.yaml` reads `worker.command` and `worker.args` and passes them through to the container spec; the value above swaps `start` (which exits) for `--daemon` (which runs the HTTP server in the foreground).
>
> **Bitnami postgres image gotcha (Aug 2025+).** The bitnami subchart pulls `docker.io/bitnami/postgresql:<version>`, but Bitnami moved versioned tags to a paid registry — the public Docker Hub repo only has `latest` and digest-tags now, so `pulumi up` / `helm install` will fail with `ImagePullBackOff` and `failed to resolve reference … not found`. The community fork `bitnamilegacy/postgresql` keeps the tags. Pin it:
>
> ```
> --set postgresql.image.repository=bitnamilegacy/postgresql \
> --set postgresql.image.tag=17.6.0-debian-12-r4
> ```
>
> **Chroma 0.5.20 + `runAsNonRoot: true` is broken.** The default chroma image tries to write `/chroma/chroma.log` (a path baked into its `log_config.yml`) and crashes with `PermissionError: [Errno 13] Permission denied` when the chart's pod security context forces user 1000. Until upstream chroma logs to stdout (or the chart adds a writable log path), set `--set chroma.enabled=false`. The worker continues to run; only semantic search degrades.

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
| Dockerfile only copies `worker-service.cjs` — plugin assets missing at runtime | `/modes`, `/ui`, `/skills`, `/plugin/.mcp.json`, `/package.json` not copied | Until upstream patch lands, add the `COPY` lines from [§1](#1-build-and-push-the-image) |
| Container `CMD start` exits cleanly → K8s restart loop                     | `bun worker-service.cjs start` daemonizes and exits 0; the foreground HTTP server runs under `--daemon` | Until upstream patch lands, override `worker.command` (see [§3](#3-install-the-chart)) |
| Public bitnami postgres tags paywalled (Aug 2025+)                         | `docker.io/bitnami/postgresql:<version>` returns `not found`                    | Pin `postgresql.image.repository=bitnamilegacy/postgresql` |
| Chroma 0.5.20 default image incompatible with `runAsNonRoot: true`         | Image tries to write `/chroma/chroma.log` (non-writable for uid 1000)           | Set `chroma.enabled=false`; revisit when chroma logs to stdout or chart adds writable log path |
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
| `chroma.enabled`        | `true`                          | **Set to `false`** — 0.5.20 default image fails under `runAsNonRoot: true`. Worker runs without it. |
| `worker.command`        | `[]` (uses image CMD)           | **Set to `[bun, worker-service.cjs, --daemon]`** until image CMD is fixed |
| `worker.args`           | `[]`                            | Container `args` override; rarely needed alongside `worker.command` |
| `ingress.hosts[0].host` | `mem.example.com`               | Replace with your domain                                            |
| `backup.enabled`        | `false`                         | Postgres-only; opt-in                                               |
| `postgresql.enabled`    | `true`                          | Set false to bring your own Postgres or run sqlite mode             |

Defaults live in `helm/claude-mem/values.yaml`.
