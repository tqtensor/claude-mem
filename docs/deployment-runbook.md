# Kubernetes Deployment Runbook

How to deploy claude-mem to a Kubernetes cluster (validated against Nebius; works on any cluster with nginx-ingress + cert-manager).

This runbook covers two shippable paths:

- **SQLite + local PVC** — original "single replica, file-backed" path. Best for one-machine personal use; do not use NFS storage (SQLite WAL is incompatible with NFS).
- **Postgres (bitnami subchart) + Cloudflare-fronted ingress + LiteLLM/OpenRouter for AI summaries** — validated end-to-end against `https://mem.company.com` on a Nebius cluster. Sessions, prompts, and observations write to Postgres; LLM summarization runs through a self-hosted LiteLLM proxy serving Claude Sonnet 4.6. **Chroma is off** in this path — see [Limitations](#limitations).

The doc walks through everything: image build, registry, TLS, ingress, helm install, AI provider, and (the painful one) wiring an *unpublished* feature branch of claude-mem into Claude Code's marketplace plugin.

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

The worker historically called `SessionStore.ts` directly via `bun:sqlite`. The async sweep landed on `feat/k8s-deployment` (commits `5c2230db refactor: route sqlite layer through async DbAdapter` + `7510073b test: await async sqlite layer calls`), and Postgres mode now writes sessions/prompts/observations end-to-end against `bitnamilegacy/postgresql:17.6.0-debian-12-r4`. SQLite remains the safer default for a single-machine deploy because no chart limitation rules out NFS for Postgres data.

### Wiring an AI provider for summarization

By default the worker shells out to a `claude` CLI inside the pod for summaries — the docker image doesn't bundle the CLI, so you'll see `Generator failed: Claude executable not found` and only raw observations get persisted. Pick one of the two HTTP providers instead:

**OpenRouter (or any OpenRouter-compatible proxy, e.g. LiteLLM)** — set these in `worker.env`:

```yaml
worker:
  env:
    CLAUDE_MEM_PROVIDER: openrouter
    CLAUDE_MEM_OPENROUTER_BASE_URL: https://litellm.company.com/v1/chat/completions  # or https://openrouter.ai/api/v1/chat/completions
    CLAUDE_MEM_OPENROUTER_MODEL: claude-sonnet-4-6-bedrock                                # whatever your proxy advertises
    CLAUDE_MEM_OPENROUTER_API_KEY: sk-...                                                  # mount from a Secret in real deployments
```

The base-URL override is `feat/k8s-deployment` only (commit `36623f4a feat: allow overriding openrouter base url via setting`); upstream hardcodes `openrouter.ai`. Without it, you can only point at openrouter.ai itself.

Smoke-test the proxy from your laptop before deploying — saves an iteration:

```bash
curl -fsS -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6-bedrock","messages":[{"role":"user","content":"hi"}],"max_tokens":20}' \
  https://litellm.company.com/v1/chat/completions
```

**Gemini** (free tier available): `CLAUDE_MEM_PROVIDER=gemini`, `CLAUDE_MEM_GEMINI_API_KEY=...`.

### Worker environment knobs

The `worker.env` map (added in commit `ac4747b8 feat: pass worker.env values through to container`) is a generic key→value passthrough into the container's `env:` array. Useful entries discovered while bringing up `mem.company.com`:

| Env var                          | Purpose                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLAUDE_MEM_PROVIDER`            | `openrouter` / `gemini` / `claude` (default — needs CLI in pod)                                                                                              |
| `CLAUDE_MEM_OPENROUTER_BASE_URL` | Override for OpenRouter URL — point at LiteLLM/proxies                                                                                                       |
| `CLAUDE_MEM_OPENROUTER_MODEL`    | Model id as advertised by the proxy                                                                                                                          |
| `CLAUDE_MEM_OPENROUTER_API_KEY`  | Bearer key (sops-encrypt + project through pulumi/secret-mount)                                                                                              |
| `CLAUDE_MEM_CHROMA_ENABLED`      | `false` to suppress chroma-mcp spawn attempts when chart's `chroma.enabled=false`                                                                            |
| `CLAUDE_MEM_CORS_EXTRA_ORIGINS`  | Comma-separated browser origins to allow (e.g. `https://mem.company.com` for the bundled viewer SPA). Hooks themselves bypass CORS via Authorization header. |

### CORS and the Authorization bypass

The worker's CORS middleware historically allowed only `localhost`/`127.0.0.1`. Commit `e8fa3b5e fix: bypass cors for bearer-authenticated requests` makes any request carrying an `Authorization` header skip CORS entirely (auth is the actual gate; Origin is a browser-only signal). That's why hooks work from anywhere without origin allowlisting. The browser-served viewer SPA still needs an explicit `CLAUDE_MEM_CORS_EXTRA_ORIGINS` entry though — set it to your public hostname.

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

Each developer needs: `node` ≥ 20, `npx`, `npm`, `git`, `jq`, `curl`, plus their personal API key (distributed out-of-band).

> **Why this isn't a one-liner.** `npx -y claude-mem install` clones the marketplace plugin from upstream `thedotmack/claude-mem`, whose published versions do not contain remote-worker support. The hook reads `CLAUDE_MEM_REMOTE_URL` from `~/.claude-mem/settings.json`, doesn't recognize it, and falls back to `localhost:37777` — which has nothing listening, so the hook silently fails-closed. The remote-worker code, CORS auth-bypass, OpenRouter base-URL override, Dockerfile fix, and chart `worker.command/env` passthroughs all live on a fork's `feat/k8s-deployment` branch (e.g. `<your-gh-user>/claude-mem`). The steps below bootstrap once with `npx`, then replace the marketplace dir with a fresh clone of the fork branch.
>
> The marketplace dir created by `npx claude-mem install` is a **flat copy, not a git repo** — `git remote set-url` / `git fetch` against it will fail. You have to delete it and re-clone.

### 1. Bootstrap the marketplace clone

```bash
npx -y claude-mem@latest install
```

Creates `~/.claude/plugins/marketplaces/thedotmack/` (flat copy from upstream), registers the plugin in `~/.claude/plugins/known_marketplaces.json`, runs `npm install`, and writes `~/.claude-mem/settings.json` with defaults.

### 2. Replace the marketplace dir with the fork branch

```bash
rm -rf ~/.claude/plugins/marketplaces/thedotmack
git clone --depth 1 -b feat/k8s-deployment \
  https://github.com/<your-gh-user>/claude-mem.git \
  ~/.claude/plugins/marketplaces/thedotmack
(cd ~/.claude/plugins/marketplaces/thedotmack && npm install)
```

Verify the fork's hooks landed:

```bash
grep -rl "CLAUDE_MEM_REMOTE_URL" ~/.claude/plugins/marketplaces/thedotmack/plugin/ \
  | wc -l                       # expect ≥ 3
grep -c "headers.authorization" \
  ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs
                                # expect ≥ 1 (CORS auth-bypass commit)
```

If either count is 0, the clone didn't land — re-run.

### 3. Wipe the versioned plugin cache

```bash
rm -rf ~/.claude/plugins/cache/thedotmack/claude-mem/*
```

The hook resolves the versioned cache directory (`~/.claude/plugins/cache/thedotmack/claude-mem/<version>/`) before falling back to the marketplace dir. With the cache empty, the marketplace dir (now the fork branch) becomes the resolved source. The cache is keyed by the version in `.claude-plugin/marketplace.json` — if you bump that on the fork without wiping the cache, a stale `<version>/` dir will resolve instead of the new one.

### 4. Disable autoUpdate and re-point the registry

```bash
jq '.thedotmack.autoUpdate = false
    | .thedotmack.source.repo = "<your-gh-user>/claude-mem"' \
   ~/.claude/plugins/known_marketplaces.json > /tmp/km && \
  mv /tmp/km ~/.claude/plugins/known_marketplaces.json
```

Without this, Claude Code will silently revert to upstream `main` on its next plugin sync.

### 5. Write the remote URL and API key into settings

```bash
URL="https://mem.company.com"
KEY="<personal-api-key>"

jq --arg url "$URL" --arg key "$KEY" \
   '. + {"CLAUDE_MEM_REMOTE_URL": $url, "CLAUDE_MEM_API_KEY": $key}' \
   ~/.claude-mem/settings.json > /tmp/cm && \
  mv /tmp/cm ~/.claude-mem/settings.json
```

Equivalent to running the fork's `scripts/team-setup.sh --url $URL --key $KEY`, but skips the `npx install` step (we already ran it in step 1 and replaced its output in step 2).

### 6. Restart Claude Code

Required — the hooks load `~/.claude-mem/settings.json` once at session start.

### Verify

After restart, watch hooks call into the cluster (cluster admins only):

```bash
kubectl -n claude-mem logs -f deploy/claude-mem
```

Expected: `→ POST /api/observations`, `→ POST /api/init`, etc., with `200 OK` responses. End-users without cluster access can confirm with the auth-gated endpoint check:

```bash
curl -i -H "Authorization: Bearer $KEY" https://mem.company.com/api/version | head -1
# → HTTP/2 200
```

### Footguns

- **Re-running `npx claude-mem install` resets everything.** It repopulates `~/.claude/plugins/marketplaces/thedotmack/` from upstream and flips `autoUpdate` back to `true`. Repeat steps 2–4 after any future install/upgrade.
- **Hooks fail closed.** If the remote worker is unreachable, you'll see "remote worker unreachable" warnings rather than a fallback to local mode. Hit `/api/health` first when debugging.
- **API keys aren't recoverable** from the cluster — only their SHA-256 hash is stored. Save it in a password manager when issued.

### Upgrading later

When a newer commit lands on `feat/k8s-deployment`:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
git fetch origin feat/k8s-deployment
git reset --hard FETCH_HEAD
npm install
rm -rf ~/.claude/plugins/cache/thedotmack/claude-mem/*
# Then restart Claude Code.
```

This works because step 2 above replaced the flat copy with a real git clone — `git fetch` / `git reset --hard` are valid here, unlike against the dir that `npx install` produces.

### Why `npm publish` doesn't fix this

`npx claude-mem install` only installs the npm package's *installer CLI*. The plugin assets themselves come from the GitHub marketplace clone, not from npm. Bumping the npm version doesn't help unless the corresponding GitHub commit is on `main` of the upstream repo. The pragmatic fix is the fork swap above; the upstream fix is opening a PR to `thedotmack/claude-mem` to merge the remote-worker work.

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

| Limitation                                                                                                            | Owner                                                                                                   | Tracked                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote-worker support, CORS bypass, OpenRouter base-URL override, Dockerfile + chart fixes live only on a fork branch | Upstream `thedotmack/claude-mem main` doesn't include them; `npx claude-mem install` clones from there  | Use the fork swap in [§5](#5-wire-local-claude-code-to-the-cluster); long-term, open a PR upstream                                                                |
| Dockerfile only copies `worker-service.cjs` — plugin assets missing at runtime                                        | `/modes`, `/ui`, `/skills`, `/plugin/.mcp.json`, `/package.json` not copied                             | Patched on `feat/k8s-deployment` (commit `062f7b7e`); upstream still needs the `COPY` lines from [§1](#1-build-and-push-the-image)                                |
| Container `CMD start` exits cleanly → K8s restart loop                                                                | `bun worker-service.cjs start` daemonizes and exits 0; the foreground HTTP server runs under `--daemon` | Workaround on `feat/k8s-deployment` via `worker.command` passthrough (commits `af6197ea` + `ac4747b8`); see [§3](#3-install-the-chart)                            |
| Worker AI defaults to `claude` CLI (not in image)                                                                     | Boots OK, but summarization always fails until you set `CLAUDE_MEM_PROVIDER=openrouter` (or `gemini`)   | OpenRouter base-URL override added on `feat/k8s-deployment` (commit `36623f4a`); upstream hardcodes openrouter.ai                                                 |
| Public bitnami postgres tags paywalled (Aug 2025+)                                                                    | `docker.io/bitnami/postgresql:<version>` returns `not found`                                            | Pin `postgresql.image.repository=bitnamilegacy/postgresql`                                                                                                        |
| Chroma 0.5.20 default image incompatible with `runAsNonRoot: true`                                                    | Image tries to write `/chroma/chroma.log` (non-writable for uid 1000)                                   | Set `chroma.enabled=false` *and* `worker.env.CLAUDE_MEM_CHROMA_ENABLED=false`. Worker logs `[CHROMA] User prompt sync failed` if you only do the chart-side flag. |
| No horizontal scaling (`replicas: 1` hardcoded)                                                                       | Worker holds in-process state (rate limits, branch manager, SSE, search caches)                         | Future phase: externalize state to Redis + leader election                                                                                                        |
| Local SQLite history not migrated to team server                                                                      | New users start with an empty server view of the cluster                                                | Out of scope for v1                                                                                                                                               |
| Chroma collection is single-tenant (no per-user isolation in vector store)                                            | `ChromaSync.ts` writes lack `user_id` metadata                                                          | `docs/team-k8s-plan.md` Phase 4                                                                                                                                   |
| Backup CronJob only supports PostgreSQL                                                                               | SQLite snapshotting is operator-driven (`kubectl cp`)                                                   | Acceptable; revisit if SQLite mode persists long-term                                                                                                             |

---

## Reference: chart values matrix

| Value                                         | Default                                              | Notes                                                                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image.repository`                            | `ghcr.io/thedotmack/claude-mem`                      | Override for your registry                                                                                                                                                          |
| `image.tag`                                   | `""` (uses `Chart.AppVersion`)                       | Pin in production                                                                                                                                                                   |
| `worker.port`                                 | `37777`                                              | Drives container, service, probes — single source of truth                                                                                                                          |
| `worker.command`                              | `[]` (uses image CMD)                                | **Set to `[bun, worker-service.cjs, --daemon]`** until image CMD is fixed                                                                                                           |
| `worker.args`                                 | `[]`                                                 | Container `args` override; rarely needed alongside `worker.command`                                                                                                                 |
| `worker.env`                                  | `{}`                                                 | Generic env-var map projected into the deployment. Used for AI provider, CORS, chroma off-switch — see [§3](#3-install-the-chart).                                                  |
| `database.type`                               | `postgres`                                           | `sqlite` is safer single-machine; `postgres` validated end-to-end on `feat/k8s-deployment`                                                                                          |
| `database.sqlite.size`                        | `10Gi`                                               | Resize the PVC manually if needed; cannot shrink                                                                                                                                    |
| `auth.keys`                                   | `{}`                                                 | Map of `username → key`. **Empty = unauthenticated worker**                                                                                                                         |
| `auth.rateLimitRpm`                           | `60`                                                 | Per-IP requests/minute                                                                                                                                                              |
| `chroma.enabled`                              | `true`                                               | **Set to `false`** — 0.5.20 default image fails under `runAsNonRoot: true`. Also set `worker.env.CLAUDE_MEM_CHROMA_ENABLED=false` so the worker stops trying to spawn `chroma-mcp`. |
| `ingress.annotations`                         | `{cert-manager.io/cluster-issuer: letsencrypt-prod}` | Override to `{}` (or just nginx-relevant entries) when using Cloudflare Origin CA — otherwise cert-manager and the origin cert race                                                 |
| `ingress.hosts[0].host`                       | `mem.example.com`                                    | Replace with your domain                                                                                                                                                            |
| `ingress.tls[0].secretName`                   | `claude-mem-tls`                                     | Reference an existing TLS secret (Cloudflare Origin CA) instead of letting cert-manager mint one                                                                                    |
| `backup.enabled`                              | `false`                                              | Postgres-only; opt-in                                                                                                                                                               |
| `postgresql.enabled`                          | `true`                                               | Set false to bring your own Postgres or run sqlite mode                                                                                                                             |
| `postgresql.image.repository`                 | `bitnami/postgresql`                                 | **Override to `bitnamilegacy/postgresql`** — public bitnami tags moved to a paid registry in Aug 2025                                                                               |
| `postgresql.image.tag`                        | (subchart default)                                   | Pin to e.g. `17.6.0-debian-12-r4` so the new repo can resolve it                                                                                                                    |
| `postgresql.primary.persistence.storageClass` | `""` (default class)                                 | Set to a non-NFS class for SQLite; NFS works for Postgres + Chroma                                                                                                                  |

Defaults live in `helm/claude-mem/values.yaml`.
