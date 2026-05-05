# Team Kubernetes Deployment Plan

PostgreSQL support + Kubernetes Helm chart for shared team memory.

## Goal

Enable multiple developers to share a single persistent memory store hosted on Kubernetes. Each developer installs claude-mem locally; their hooks send observations to and pull context from a central K8s-hosted worker instead of a local process.

## Architecture

```
Developer Machine (Claude Code)
  └─ claude-mem plugin hooks
       └─ worker-utils.ts [remote mode bypass]
            └─ HTTPS → Cloudflare DNS → nginx Ingress (cert-manager TLS)
                                          └─ claude-mem worker Pod
                                               ├─ PostgreSQL (Bitnami subchart or external)
                                               └─ Chroma Pod
```

## Technical Decisions

| Decision              | Choice                                                           | Rationale                                                                      |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| PostgreSQL driver     | `Bun.sql` (built into Bun ≥1.1)                                  | No extra npm dep, same runtime, same external-module treatment as `bun:sqlite` |
| SQL parameterization  | `?` placeholders everywhere; PostgreSQL adapter converts to `$N` | Keeps all existing SQL strings unchanged                                       |
| FTS in PostgreSQL     | `tsvector` + GIN indexes + `BEFORE INSERT/UPDATE` triggers       | Full parity with SQLite FTS5                                                   |
| Helm chart location   | `helm/claude-mem/` in this repo                                  | Versioned alongside the app                                                    |
| PostgreSQL deployment | Both bundled (Bitnami subchart) and external                     | Flexibility for teams with/without managed Postgres                            |

---

## Phase 0: Dockerfile + Container Build

### `Dockerfile`

```dockerfile
FROM oven/bun:1.2-alpine AS base   # must satisfy engines.bun ≥1.2.0 — see package.json bump below

WORKDIR /app

# Install uv (Python package runner) — required by ChromaMcpManager which
# always spawns chroma-mcp via `uvx`, even when CHROMA_MODE=remote (the env
# var only flips --client-type to http; the uvx process still runs).
# If a future Alpine base ships `uv` as a first-class package, replace this
# with `apk add --no-cache uv`. The pip+--break-system-packages form is a
# stop-gap, not a preference.
RUN apk add --no-cache python3 py3-pip ca-certificates \
  && pip install --break-system-packages uv

# Copy pre-built artifacts — run `npm run build` before `docker build`
COPY plugin/scripts/worker-service.cjs .
COPY plugin/package.json .
RUN bun install --production

# Create data dir owned by app user before switching
RUN mkdir -p /data && chown 1000:1000 /data
VOLUME ["/data"]
USER 1000

ARG WORKER_PORT=37777
EXPOSE ${WORKER_PORT}
ENV CLAUDE_MEM_WORKER_HOST=0.0.0.0
ENV CLAUDE_MEM_WORKER_PORT=${WORKER_PORT}
ENV CLAUDE_MEM_DATA_DIR=/data
ENV CLAUDE_MEM_CHROMA_MODE=remote
# WORKER_PORT must agree with helm/claude-mem values.yaml `worker.port`. The
# Helm chart wires the same value into Service targetPort, containerPort, and
# probe ports so a single knob drives all of them — see Phase 7.

CMD ["bun", "worker-service.cjs", "start"]
```

### `.github/workflows/docker.yml`

- Trigger: push to `main` and `v*` tags
- Steps (in order — the build step is required because the Dockerfile copies pre-built `worker-service.cjs`, not source):
  1. `actions/checkout`
  2. `actions/setup-node` + `oven-sh/setup-bun`
  3. `npm ci` (or `bun install --frozen-lockfile`)
  4. **`npm run build`** — produces `plugin/scripts/worker-service.cjs` and friends
  5. `docker/setup-qemu-action` + `docker/setup-buildx-action`
  6. `docker/login-action` (ghcr.io)
  7. `docker/build-push-action` with platforms `linux/amd64,linux/arm64`
- Build + push to `ghcr.io/thedotmack/claude-mem`
- Tags: `latest` on main, semver on tags

Without step 4 the image will ship a stale or empty `.cjs` and the worker will fail to start with no obvious error. Test the workflow with `act` or a feature-branch tag before relying on it.

### `.dockerignore` additions

```
src/
dist/
*.test.ts
evals/
ragtime/
```

### `package.json` engines bump

```json
"engines": { "bun": ">=1.2.0", "node": ">=20.0.0" }
```

(Pinned at the floor where native `Bun.sql` Postgres support — `sql.unsafe`, `sql.begin`, dollar-quoted strings — is stable. **Do not pin lower** — Bun 1.1.x ships SQLite-only `Bun.sql`; importing the Postgres driver will throw at adapter init. Re-verify against current Bun release notes before merging Phase 0; bump the floor if a later version is the real "stable" line.)

---

## Phase 1: Database Abstraction Layer

### New directory: `src/services/database/`

#### `src/services/database/DbAdapter.ts`

```typescript
export interface RunResult {
  lastInsertRowid?: number | bigint;
  changes?: number;
}

export interface DbAdapter {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;       // multi-statement DDL, no params
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

#### `src/services/database/SqliteAdapter.ts`

- Import `Database` from `bun:sqlite`
- `all/get/run`: wrap sync bun:sqlite calls in `Promise.resolve()`
- `exec(sql)`: pass the entire string to `db.run(sql)` — bun:sqlite already supports multi-statement DDL natively. **Do NOT split on `;`** (would shatter quoted strings and would have no benefit here).
- `transaction(fn)`: **do NOT use `db.transaction()`** — it's synchronous and won't await async callbacks. Use explicit SQL **plus an internal async mutex** so concurrent callers serialize on the single bun:sqlite connection:
  ```typescript
  private txMutex: Promise<unknown> = Promise.resolve();

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.txMutex;
    let release!: (v?: unknown) => void;
    this.txMutex = new Promise(r => (release = r));
    try {
      await prev;
      this.db.run('BEGIN');
      try {
        const result = await fn();
        this.db.run('COMMIT');
        return result;
      } catch (e) {
        this.db.run('ROLLBACK');
        throw e;
      }
    } finally {
      release();
    }
  }
  ```

#### `src/services/database/PostgresAdapter.ts`

- Import `SQL` from `bun` (`Bun.sql` Postgres driver — requires Bun ≥1.2.0; pin in `package.json` `engines`)
- `all/get/run`: use `this.sql.unsafe(convertPlaceholders(sql), params ?? [])`
- `convertPlaceholders(sql)`: replace unquoted `?` sequentially with `$1, $2, ...`
  - Must respect single-quoted string literals **including doubled-quote escapes** (`'don''t'`)
  - Must respect dollar-quoted strings (`$$ ... $$`, `$tag$ ... $tag$`)
  - Implementation: a small character-stream parser, not a regex. Add unit tests covering: bare `?`, `?` inside `'...'`, `?` inside `'...''...?'`, `?` inside `$$...?...$$`, `?` inside double-quoted identifier (`"col?name"`), `?` inside line comment (`-- ?`) and block comment (`/* ? */`), mixed `?` + literal `$1`, no `?`.
- `exec(sql)`: pass the entire string to `this.sql.unsafe(sql)` as a single call — `Bun.sql` accepts multi-statement scripts and runs them in one round-trip. **Do NOT split on `;`** (would shatter `$$…$$` plpgsql function bodies in `postgres-schema.sql`).
- `transaction(fn)`: use `this.sql.begin(async (tx) => { ... })` — `Bun.sql` already serializes the connection it hands to the callback, so no extra mutex needed
- Connection string from `CLAUDE_MEM_DATABASE_URL`; pool sizing via `?max=N` query-string param (default 10 for the worker)

#### `src/services/database/AdapterFactory.ts`

- Read `CLAUDE_MEM_DB_TYPE` (`sqlite` | `postgres`, default: `sqlite`)
- Read `CLAUDE_MEM_DATABASE_URL` for postgres connection string
- Return the correct `DbAdapter` instance

### Modified: `src/shared/SettingsDefaultsManager.ts`

Add to `SettingsDefaults` interface and `DEFAULTS`:

```typescript
CLAUDE_MEM_DB_TYPE: 'sqlite',       // 'sqlite' | 'postgres'
CLAUDE_MEM_DATABASE_URL: '',        // postgres://user:pass@host:5432/dbname
CLAUDE_MEM_REMOTE_URL: '',          // https://mem.company.com  (client-side remote mode)
CLAUDE_MEM_API_KEY: '',             // Bearer token sent by hooks in client mode
CLAUDE_MEM_API_KEYS: '',            // Server-side: "alice:key1,bob:key2"
```

---

## Phase 2: Make Database Layer Async

The conversion is **one atomic sweep**, not a per-file rollout. The codebase has ~250 direct `this.db.*` call sites in `SessionStore.ts` alone, plus prepared-statement chains (`db.prepare(...).get/run`), `db.query('PRAGMA ...').all()`, and sync `db.transaction()` blocks. TypeScript will not compile while half the call sites return `T` and the other half return `Promise<T>`, so an incremental file-by-file rollout is not feasible.

### Approach

1. Replace `this.db: Database` with `this.adapter: DbAdapter` everywhere, in one branch.
2. Replace direct prepared-statement caching (`const stmt = this.db.prepare(...); stmt.run(...)`) with `await this.adapter.run(sql, params)`. Statement caching is now the adapter's responsibility.
3. Replace `db.query('PRAGMA table_info(...)').all()` with adapter-level introspection (SQLite-only path; on PostgreSQL these calls live behind a `dbType === 'sqlite'` guard).
4. Convert every method that previously called `this.db.*` to `async`, propagate `await` to all callers, update return types.
5. Single smoke-test gate at the end of the sweep: `npm run build-and-sync` + full session round-trip in SQLite mode must pass before Phase 3 starts.

### Modified files in `src/services/sqlite/`

All files in this directory that import `bun:sqlite` need conversion. Use this command to enumerate before starting and as a completion check:

```bash
grep -rln "from 'bun:sqlite'\|from \"bun:sqlite\"" src/services/sqlite/
```

Expected files (verified at planning time): `Database.ts`, `SessionStore.ts` (~246 call sites), `SessionSearch.ts` (~80 call sites; also adds PostgreSQL FTS branch — see Phase 3), `PendingMessageStore.ts`, `transactions.ts`, `migrations.ts` (legacy 549-line monolith — confirm whether superseded by `migrations/runner.ts`; either convert or delete in this sweep so the TS-compile gate passes), `migrations/runner.ts` (Phase 3), and every file under `observations/`, `prompts/`, `sessions/`, `summaries/`, `timeline/`, `import/`.

The capitalized facade files (`Observations.ts`, `Sessions.ts`, `Summaries.ts`, `Prompts.ts`, `Timeline.ts`, `Import.ts`) are pure re-export barrels — no conversion needed.

### Modified files in `src/services/worker/`

| File                                        | Change                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `DatabaseManager.ts`                        | Replace `import { Database } from 'bun:sqlite'` with `DbAdapter` from `AdapterFactory`; all store/search instantiation updated |
| `PaginationHelper.ts`                       | Currently imports `bun:sqlite` directly — convert to `DbAdapter`                                                               |
| `search/strategies/SQLiteSearchStrategy.ts` | Add `await` to all `SessionSearch` calls                                                                                       |
| `search/strategies/HybridSearchStrategy.ts` | Add `await` where needed                                                                                                       |
| `search/SearchOrchestrator.ts`              | Add `await` where needed                                                                                                       |
| `http/routes/*.ts`                          | Add `await` to every store/search call site                                                                                    |

### `bun:sqlite` consumers outside `src/services/sqlite/`

These files import `bun:sqlite` directly and must either be converted to `DbAdapter` or hard-disabled when `CLAUDE_MEM_DB_TYPE=postgres`. Default is to convert. Hard-disable is acceptable only for code paths that are SQLite-only by design (e.g., local-machine cleanup utilities that never run server-side).

| File                                              | Decision                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/cli/claude-md-commands.ts`                   | Convert. The CLI is invoked by developers; in remote mode it should hit the API, not the local DB. Remote-aware path required. |
| `src/services/infrastructure/ProcessManager.ts`   | SQLite-only by design (manages local worker pid/db). Hard-disable in PG mode (early return, log a warn).                       |
| `src/services/infrastructure/CleanupV12_4_3.ts`   | SQLite-only one-shot upgrade utility. Hard-disable in PG mode.                                                                 |
| `src/services/infrastructure/WorktreeAdoption.ts` | SQLite-only (local worktree state). Hard-disable in PG mode.                                                                   |

### Gating rule

Single end-of-sweep gate: SQLite local mode must pass a hook smoke-test (`npm run build-and-sync` + full session round-trip) before Phase 3 starts. **Add unit tests against the new `DbAdapter` interface** covering: `all`/`get`/`run` semantics, multi-statement `exec`, transaction commit/rollback, and concurrent transaction serialization (the mutex). Run against both `SqliteAdapter` and `PostgresAdapter` (testcontainers).

---

## Phase 3: Migration Runner — PostgreSQL Support

### Modified: `src/services/sqlite/migrations/runner.ts`

The runner needs a structural rewrite, not a global `db.run` → `adapter.exec` rename. The existing 32+ migrations rely on SQLite-only mechanics that have no PostgreSQL equivalent:

- `PRAGMA table_info(...)` / `PRAGMA index_list(...)` introspection
- Column-by-column `ALTER TABLE … ADD/DROP COLUMN`
- `randomblob(8)` for backfill default values
- Synchronous `db.transaction()` callbacks
- `INSERT OR IGNORE` upserts on `schema_versions`

```typescript
// Change constructor signature:
constructor(
  private adapter: DbAdapter,
  private dbType: 'sqlite' | 'postgres',
) {}

// Make runAllMigrations() async:
async runAllMigrations(): Promise<void> {
  if (this.dbType === 'postgres') {
    await this.runPostgresBootstrap();
    await this.runVersionedMigrations(); // engine-aware, see below
    return;
  }
  await this.runSqliteMigrations();      // existing path, converted to async
}
```

**SQLite path (`runSqliteMigrations`)**: line-by-line port of the current logic — every `this.db.prepare(...).get/run/all` becomes `await this.adapter.get/run/all(...)`; every `this.db.query('PRAGMA ...').all()` stays inside `if (this.dbType === 'sqlite')` blocks; every sync `db.transaction(() => { ... })` becomes `await this.adapter.transaction(async () => { ... })`.

**PostgreSQL bootstrap (`runPostgresBootstrap`)**: if `schema_versions` is empty, apply `src/services/database/migrations/postgres-schema.sql` as a single `await this.adapter.exec(sql)` call (the schema must be idempotent — uses `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, etc.), then INSERT a baseline version row matching the current SQLite head version.

**Engine-aware versioned migrations**: post-bootstrap migrations live in `src/services/database/migrations/v{NNN}-{slug}/` directories with `sqlite.sql` and `postgres.sql` siblings. The runner picks the file matching `dbType`. This replaces the current monolithic if/else chain in `runner.ts` and resolves the v33 cross-engine ambiguity (each engine applies its own DDL under the same version row).

### New: `src/services/database/migrations/postgres-schema.sql`

```sql
-- Core tables (GENERATED ALWAYS AS IDENTITY, JSONB columns)
CREATE TABLE IF NOT EXISTS schema_versions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version INTEGER UNIQUE NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sdk_sessions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  content_session_id TEXT UNIQUE NOT NULL,
  memory_session_id TEXT UNIQUE,
  project TEXT NOT NULL,
  platform_source TEXT NOT NULL DEFAULT 'claude',
  user_id TEXT,
  user_prompt TEXT,
  started_at TEXT NOT NULL,
  started_at_epoch BIGINT NOT NULL,
  completed_at TEXT,
  completed_at_epoch BIGINT,
  status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active',
  worker_port INTEGER,
  prompt_counter INTEGER DEFAULT 0,
  custom_title TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  user_id TEXT,
  text TEXT,
  type TEXT NOT NULL,
  title TEXT,
  subtitle TEXT,
  facts JSONB,
  narrative TEXT,
  concepts JSONB,
  files_read JSONB,
  files_modified JSONB,
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  content_hash TEXT,
  agent_type TEXT,
  agent_id TEXT,
  merged_into_project TEXT,
  generated_by_model TEXT,
  metadata JSONB,
  created_at TEXT NOT NULL,
  created_at_epoch BIGINT NOT NULL,
  search_vector tsvector,
  UNIQUE(memory_session_id, content_hash),
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- (session_summaries, pending_messages, user_prompts — same pattern: GENERATED IDENTITY PK,
--  JSONB for structured fields, tsvector search_vector column with BEFORE INSERT/UPDATE
--  trigger, user_id TEXT column.)

CREATE TABLE IF NOT EXISTS observation_feedback (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observation_id INTEGER NOT NULL,
  memory_session_id TEXT,
  user_id TEXT,
  signal TEXT NOT NULL,                    -- 'used' | 'ignored' | etc. (mirror SQLite enum)
  weight REAL DEFAULT 1.0,
  metadata JSONB,
  created_at TEXT NOT NULL,
  created_at_epoch BIGINT NOT NULL,
  FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE
);
CREATE INDEX idx_observation_feedback_observation ON observation_feedback(observation_id);
CREATE INDEX idx_observation_feedback_user        ON observation_feedback(user_id);

-- Cross-check the column shape against src/services/sqlite/schema.sql:175 before
-- shipping — postgres-schema.sql must stay structurally faithful to the SQLite source.

-- GIN indexes for FTS
CREATE INDEX idx_observations_search ON observations USING GIN(search_vector);
CREATE INDEX idx_summaries_search ON session_summaries USING GIN(search_vector);
CREATE INDEX idx_prompts_search ON user_prompts USING GIN(search_vector);

-- User indexes
CREATE INDEX idx_sdk_sessions_user ON sdk_sessions(user_id);
CREATE INDEX idx_observations_user ON observations(user_id);

-- tsvector trigger for observations
-- Use the 'simple' configuration (no stemming, no stopwords) for parity with
-- SQLite FTS5's default unicode61 tokenizer. The 'english' stemmer mangles
-- code identifiers (`getWorkerPort` → `getworkerport`, `services` → `servic`)
-- and would produce different ranking + hit sets than local SQLite mode.
CREATE OR REPLACE FUNCTION observations_tsvector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('simple',
    coalesce(NEW.title, '') || ' ' ||
    coalesce(NEW.subtitle, '') || ' ' ||
    coalesce(NEW.narrative, '') || ' ' ||
    coalesce(NEW.text, '') || ' ' ||
    coalesce(NEW.facts::text, '') || ' ' ||
    coalesce(NEW.concepts::text, '')
  );
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER observations_tsvector_trigger
  BEFORE INSERT OR UPDATE ON observations
  FOR EACH ROW EXECUTE FUNCTION observations_tsvector_update();

-- (same triggers for session_summaries and user_prompts)
```

### Modified: `SessionSearch.ts` — PostgreSQL FTS branch

```typescript
// SQLite path (unchanged):
// WHERE observations_fts MATCH ?  ORDER BY observations_fts.rank

// PostgreSQL path (use 'simple' to match the trigger config above — must
// agree or the @@ operator returns no rows):
// WHERE search_vector @@ plainto_tsquery('simple', ?)
// ORDER BY ts_rank(search_vector, plainto_tsquery('simple', ?)) DESC
```

### JSON query translation

Every `json_each` / `json_extract` / `LIKE '[%'` pattern in `src/services/sqlite/` needs a PostgreSQL equivalent. Enumerate before starting:

```bash
grep -rn "json_each\|json_extract\|LIKE '\[%'" src/services/sqlite/ --include="*.ts"
```

Known shapes (verified at planning time — `SessionStore.ts:1456,1465`, `SessionSearch.ts:191,203-204,459-460`, `observations/get.ts:51,60,121-122`):

| SQLite                                                                        | PostgreSQL                                                                                               |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)`                  | `concepts @> to_jsonb(ARRAY[$1])`                                                                        |
| `EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?)`             | `EXISTS (SELECT 1 FROM jsonb_array_elements_text(files_read) v WHERE v LIKE $1)`                         |
| `EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?)`         | `EXISTS (SELECT 1 FROM jsonb_array_elements_text(files_modified) v WHERE v LIKE $1)`                     |
| `EXISTS (SELECT 1 FROM json_each(s.files_edited) WHERE value LIKE ?)`         | `EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.files_edited) v WHERE v LIKE $1)`                     |
| `(files_read LIKE '[%' AND EXISTS (SELECT 1 FROM json_each(files_read) ...))` | Drop the `LIKE '[%'` guard entirely — SQLite-specific JSON-vs-string disambiguation, irrelevant on JSONB |

Note: the `LIKE '[%'` guards exist because SQLite stores JSON as TEXT; on PostgreSQL the columns are JSONB and the guards become dead code.

---

## Phase 4: User Namespacing

### Migration v33 — engine-divergent

Lives at `src/services/database/migrations/v33-user-namespacing/{sqlite.sql,postgres.sql}`. Both files share version 33; the runner picks one based on `dbType`.

**`sqlite.sql`** (additive, single-user safe):

```sql
ALTER TABLE sdk_sessions         ADD COLUMN user_id TEXT;
ALTER TABLE observations         ADD COLUMN user_id TEXT;
ALTER TABLE session_summaries    ADD COLUMN user_id TEXT;
ALTER TABLE user_prompts         ADD COLUMN user_id TEXT;
ALTER TABLE observation_feedback ADD COLUMN user_id TEXT;
CREATE INDEX idx_sdk_sessions_user        ON sdk_sessions(user_id);
CREATE INDEX idx_observations_user        ON observations(user_id);
CREATE INDEX idx_session_summaries_user   ON session_summaries(user_id);
CREATE INDEX idx_user_prompts_user        ON user_prompts(user_id);
CREATE INDEX idx_observation_feedback_user ON observation_feedback(user_id);
```

**`postgres.sql`** (also rewrites session-ID uniqueness):

```sql
ALTER TABLE sdk_sessions         ADD COLUMN user_id TEXT;
ALTER TABLE observations         ADD COLUMN user_id TEXT;
ALTER TABLE session_summaries    ADD COLUMN user_id TEXT;
ALTER TABLE user_prompts         ADD COLUMN user_id TEXT;
ALTER TABLE observation_feedback ADD COLUMN user_id TEXT;
CREATE INDEX idx_sdk_sessions_user         ON sdk_sessions(user_id);
CREATE INDEX idx_observations_user         ON observations(user_id);
CREATE INDEX idx_session_summaries_user    ON session_summaries(user_id);
CREATE INDEX idx_user_prompts_user         ON user_prompts(user_id);
CREATE INDEX idx_observation_feedback_user ON observation_feedback(user_id);

-- Replace the global content_session_id UNIQUE with a per-user constraint
ALTER TABLE sdk_sessions DROP CONSTRAINT sdk_sessions_content_session_id_key;
ALTER TABLE sdk_sessions ADD  CONSTRAINT sdk_sessions_content_session_id_user_id_key
  UNIQUE (content_session_id, user_id);
```

`observation_feedback` carries tier-routing usage signals tied to observations. Without `user_id`, alice's feedback would influence bob's tier routing — a subtle cross-user leak even with read paths filtered.

The SQLite path keeps the global `content_session_id UNIQUE` — single-user installs have no collision risk and changing it would force a table rebuild.

### userId threading: explicit parameter

Every store method gains a required `userId: string | null` argument. No `AsyncLocalStorage`, no implicit context — TypeScript will surface every missing callsite during the Phase 2 async sweep, and every read/write proves at the type level that it threaded a user.

- Local SQLite mode: `Database.ts`'s store factory passes `null`. Existing rows have `user_id = NULL`; new local-mode writes also store `NULL`. Backward compatible.
- Remote/server mode: HTTP routes read `req.userId` (set by auth middleware — see Phase 5) and pass it to every store call.
- Affected signatures: every method on `SessionStore`, `SessionSearch`, `PendingMessageStore`, the per-domain helpers under `observations/`, `prompts/`, `sessions/`, `summaries/`, `timeline/`, `import/`, plus `PaginationHelper`. The Phase 2 sweep is the natural moment to add the parameter — adding `userId` and converting to async happen in the same edit.

### Modified: All INSERT paths

Include the `userId` argument on every write. `userId = null` for local single-user SQLite installs (backward compatible; existing rows unaffected).

### Modified: All SELECT/search paths

Filter by `userId` using a dialect-aware predicate emitted by `DbAdapter` — never write `WHERE user_id = ?` directly. Plain equality is wrong because `NULL = NULL` is false in SQL three-valued logic, which would hide every local-mode row the moment Migration v33 runs.

```typescript
// DbAdapter exposes:
userIdPredicate(column: string): { sql: string; binds: (userId: string | null) => unknown[] }

// SqliteAdapter emits:
//   `(${column} = ? OR (${column} IS NULL AND ? IS NULL))`  → binds: [userId, userId]
// PostgresAdapter emits:
//   `${column} IS NOT DISTINCT FROM ?`                       → binds: [userId]
```

Every SELECT/search builds its WHERE clause through this helper. **No cross-user search in v1** — every developer sees only their own observations. Cross-user views can be revisited once a real role/permission model exists.

### Chroma user isolation

Postgres namespacing is not enough — the vector store is queried in parallel by `HybridSearchStrategy` and `ChromaSearchStrategy`, and a missing filter there will leak across users.

- **Storage**: every `ChromaSync.ts` write payload (`src/services/sync/ChromaSync.ts:138-194` — narrative, text, fact, request, investigated, learned variants) gains `user_id` in `metadata`. Use `null` for local-mode writes so collections stay portable.
- **Queries**: `ChromaSearchStrategy.query(...)` and any other Chroma read pass `where: { user_id: <currentUser> }`. In local mode the filter is `where: { user_id: null }` — Chroma supports null match in `$eq`.
- **Single collection, not per-user**: simpler operationally and avoids per-user provisioning. The trade-off is that any missed filter is a data leak.
- **Lint/test guardrail**: add a unit test that wraps the Chroma client and fails if `add` is called without `user_id` in metadata or `query`/`get` is called without `user_id` in `where`. Cheaper than auditing every callsite by eye.
- **Backfill**: existing embeddings (no `user_id` metadata) become invisible to the filtered query path. Acceptable for v1 because team-mode servers start with an empty Chroma store; for local-mode upgrades, document that re-indexing requires a `claude-mem reindex` (or similar) command — out of scope for v1.

### New: `src/services/worker/http/middleware/userContext.ts`

Sets `req.userId` from auth middleware result. Route handlers read `req.userId` and pass it explicitly to every store call.

### Tests

- Migration v33: idempotent re-run, both engines.
- Insert paths: writes with `user_id=null`, `user_id='alice'`, and absent header (must reject in remote-auth mode, allow in local mode).
- Read paths: alice's reads must not return bob's rows — covering SQLite (`user_id IS NULL` rows from local mode) and Postgres (server-issued user_ids).
- `userIdPredicate` adapter helper: SQLite emits the OR-with-IS-NULL form and matches null/null; Postgres emits `IS NOT DISTINCT FROM` and matches null/null. Round-trip test: insert `(null, null)` and `('alice', 'bob')` rows, query with `userId=null` returns only the null row.
- Chroma isolation: write embeddings under `user_id='alice'` and `user_id='bob'`; alice's `where: { user_id: 'alice' }` query must not return bob's IDs. Add a guardrail test that wraps the Chroma client and asserts `user_id` is present in every `add` metadata and every `query`/`get` `where`.

---

## Phase 5: API Key Auth Middleware

### New: `src/services/worker/http/middleware/auth.ts`

```typescript
// Parse CLAUDE_MEM_API_KEYS="alice:key-abc,bob:key-def" once at startup into
// a Map<sha256(key), userId>. Storing hashed keys gives O(1) lookup, no
// timing-leaked match position, and the raw key bytes only live in memory
// for the duration of parsing.
//
//   const keyMap = new Map<string, string>();
//   for (const entry of process.env.CLAUDE_MEM_API_KEYS.split(',')) {
//     const [user, key] = entry.split(':');
//     keyMap.set(sha256Hex(key), user);
//   }
//
// On each /api/* request:
//   1. Extract bearer token from Authorization header.
//   2. Compute sha256Hex(presented) and look it up in keyMap.
//   3. To preserve constant-time semantics against the lookup result,
//      crypto.timingSafeEqual the presented hash against the matched key
//      (or against a dummy 32-byte buffer when no match) before deciding.
//   4. On match, set req.userId = keyMap.get(hash). On mismatch, return 401.
//   5. If CLAUDE_MEM_API_KEYS is empty → skip auth entirely (local mode preserved).
//
// Why hash, not a linear walk: walking N timing-safe comparisons leaks the
// matching key's position via response latency (alice = first-in-map returns
// faster than carol = last-in-map) and amplifies per-request CPU cost as the
// team grows — combined with /api/* rate limits, that becomes a soft DoS.
```

**Per-IP rate limit** (same middleware): token bucket keyed by client IP, 60 requests/minute default, configurable via `CLAUDE_MEM_RATE_LIMIT_RPM`. Bounds brute-force key enumeration. Use a bounded LRU (max 10 000 entries) so the table cannot grow unbounded under attack. Note: a distributed scan with >10 000 source IPs evicts the oldest entry per request and the limit becomes ineffective per IP. Acceptable for v1; if real-world distributed scanning shows up, swap the LRU for a sliding-window ring buffer or front the cluster with a WAF/Cloudflare rule.

### Modified: `src/services/server/Server.ts`

Register auth middleware before all `/api/` routes. K8s probe paths (`/api/health`, `/api/readiness`) bypass auth.

### Modified: route handlers

Middleware-level gating only decides whether `req.userId` is set. The route handlers themselves still need to branch on it for payload shape — middleware alone won't strip verbose fields.

- `/api/health`, `/api/readiness` — when `req.userId` is unset (probe path), return only `{ status: 'ok' }`. When authenticated, return the full payload (uptime, db status, version, queue depth, etc.). Without this branch, K8s probes leak the verbose payload.
- `/api/version` — **require auth**. Leaking the worker version unauthenticated gives attackers a free CVE-matching primitive. If `req.userId` is unset → return `401`. Probes don't hit this route.

Without explicit handler-side branching, the audit checklist for Phase 5 is incomplete — call this out in route review.

---

## Phase 6: Remote Worker URL (Client Side)

### Modified: `src/shared/worker-utils.ts`

**Add `getSettingValue(key)` helper** following the same pattern as `getWorkerPort()`:

```typescript
export function getSettingValue(key: keyof SettingsDefaults): string {
  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings[key] ?? '';
}
```

**`buildWorkerUrl(apiPath)`** (currently line 69):

```typescript
export function buildWorkerUrl(apiPath: string): string {
  const remoteUrl = getSettingValue('CLAUDE_MEM_REMOTE_URL');
  if (remoteUrl) return `${remoteUrl.replace(/\/$/, '')}${apiPath}`;
  return `http://${getWorkerHost()}:${getWorkerPort()}${apiPath}`;
}
```

**`workerHttpRequest()`** — inject auth header when remote:

```typescript
const apiKey = getSettingValue('CLAUDE_MEM_API_KEY');
if (apiKey) {
  init.headers = { ...init.headers, 'Authorization': `Bearer ${apiKey}` };
}
```

**`ensureWorkerRunning()`** (currently line 224) — skip local spawn in remote mode, **fail-closed** if the remote is unreachable:

```typescript
export async function ensureWorkerRunning(): Promise<boolean> {
  const remoteUrl = getSettingValue('CLAUDE_MEM_REMOTE_URL');
  if (remoteUrl) {
    // Cache the probe result for REMOTE_HEALTH_CACHE_MS (suggest 5_000ms) so
    // hooks firing in quick succession share one health round-trip and a
    // flapping ingress doesn't hammer the worker on every tool use.
    const healthy = await isRemoteWorkerHealthy({ timeoutMs: 2_000 });
    if (!healthy) {
      // Hook contract (CLAUDE.md): exit 1 = non-blocking error, stderr shown
      // to the user. Print a clear "claude-mem: remote worker unreachable at
      // <url>" message; the calling hook script translates this return value
      // into the appropriate exit code. Do NOT exit 0 — silent drop of
      // observations is the failure mode this plan is rejecting.
      logger.warn('REMOTE', `claude-mem: remote worker unreachable at ${remoteUrl}`);
      return false;
    }
    return true;
  }
  // ... existing local spawn logic unchanged ...
}
```

A new `isRemoteWorkerHealthy()` helper probes `/api/health` (auth header injected via `workerHttpRequest()`) with a short timeout and an in-memory TTL cache. The cache key is the remote URL so multi-account setups don't share it.

**Failure mode is fail-closed by design**: a server outage surfaces a warning to the developer instead of silently dropping observations. The trade-off — Claude Code workflows degrade visibly when the team server is down — was chosen so data loss is never silent.

---

## Phase 7: Helm Chart

### Location: `helm/claude-mem/`

```
helm/claude-mem/
├── Chart.yaml
├── Chart.lock
├── values.yaml
├── charts/              # populated by helm dep update
└── templates/
    ├── _helpers.tpl
    ├── deployment.yaml  # replicas: 1 hardcoded — worker holds in-process state
    ├── service.yaml
    ├── serviceaccount.yaml
    ├── configmap.yaml
    ├── secret.yaml
    ├── pvc.yaml          # SQLite only (database.type=sqlite)
    ├── ingress.yaml
    ├── cronjob-backup.yaml
    ├── NOTES.txt
    └── chroma/
        ├── deployment.yaml
        ├── service.yaml
        └── pvc.yaml
```

**No `hpa.yaml`**: the worker keeps in-process state (`RateLimitStore`, `RestartGuard`, `BranchManager`, `ChromaSyncState`, `SearchManager` caches, SSE broadcasters). Multiple replicas would split this state and break SSE delivery + produce inconsistent searches. The chart hardcodes `replicas: 1`. A future phase can externalize state (Redis + leader election) and reintroduce HPA.

### `Chart.yaml`

```yaml
apiVersion: v2
name: claude-mem
description: Persistent memory server for Claude Code teams
type: application
version: 0.1.0
appVersion: "12.6.2"
dependencies:
  - name: postgresql
    version: ">=15.0.0 <17.0.0"
    repository: https://charts.bitnami.com/bitnami
    condition: postgresql.enabled
```

### `values.yaml` (key sections)

```yaml
image:
  repository: ghcr.io/thedotmack/claude-mem
  pullPolicy: IfNotPresent
  tag: ""  # defaults to .Chart.AppVersion

worker:
  port: 37777
  resources:
    limits: { memory: 1Gi, cpu: "1" }
    requests: { memory: 512Mi, cpu: 250m }

database:
  type: postgres           # "sqlite" | "postgres"
  url: ""                  # full DSN (overrides host/port/name/user/password if set)
  host: ""                 # for external postgres (postgresql.enabled=false)
  port: 5432
  name: claude_mem
  user: claude_mem
  password: ""
  existingSecret: ""
  existingSecretPasswordKey: password
  sqlite:
    storageClass: ""       # MUST NOT be NFS-backed (SQLite WAL incompatible with NFS)
    accessModes: [ReadWriteOnce]
    size: 10Gi

auth:
  keys: {}                 # map of username → apiKey; stored in a Secret
  existingSecret: ""
  rateLimitRpm: 60         # per-IP rate limit on /api/*

chroma:
  enabled: true
  external: false
  host: ""
  port: 8000
  apiKey: ""
  existingSecret: ""
  storageClass: ""         # MUST support ReadWriteOnce; NFS-backed not recommended
  accessModes: [ReadWriteOnce]
  size: 20Gi

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    # If using Cloudflare proxy (orange-cloud), add:
    # nginx.ingress.kubernetes.io/proxy-body-size: "10m"
  hosts:
    - host: mem.company.com   # your actual domain
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: claude-mem-tls
      hosts:
        - mem.company.com

postgresql:
  enabled: true           # false = external postgres
  auth:
    database: claude_mem
    username: claude_mem
    password: ""           # auto-generated if empty
  primary:
    persistence:
      enabled: true
      size: 10Gi
      accessModes: [ReadWriteOnce]

backup:
  enabled: false                       # disabled by default — operators opt in
  schedule: "0 2 * * *"
  image: bitnami/postgresql:16         # provides pg_dump matching the server version
  s3:
    bucket: ""
    region: ""
    prefix: "claude-mem/"
    endpoint: ""                       # optional, for S3-compatible providers
  existingSecret: ""                   # must contain AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
  retentionDays: 30                    # informational; cleanup is bucket-policy-driven, not in-job
  resources:
    limits: { memory: 512Mi, cpu: "500m" }
```

### Template highlights

**`deployment.yaml` replicas**: hardcoded `replicas: 1`. Do not parameterize.

**`deployment.yaml` probes**:
```yaml
startupProbe:
  httpGet: { path: /api/readiness, port: 37777 }
  failureThreshold: 60     # waits up to 5 min for first-boot Postgres + GIN index build
  periodSeconds: 5

readinessProbe:
  httpGet: { path: /api/readiness, port: 37777 }
  periodSeconds: 10

livenessProbe:
  httpGet: { path: /api/health, port: 37777 }
  initialDelaySeconds: 60
  periodSeconds: 30
```

**`_helpers.tpl`**:
- `claude-mem.dbUrl` — assembles `DATABASE_URL` from `database.url` or from bitnami service DNS + credentials
- `claude-mem.apiKeysValue` — encodes `auth.keys` map as `"alice:key1,bob:key2"` string for env var

**Single port source of truth**: `worker.port` (default `37777`) drives everything — `Deployment.spec.containerPort`, `Service.spec.ports[*].targetPort`/`port`, probe ports, and `CLAUDE_MEM_WORKER_PORT` env var on the container. The Dockerfile's `ARG WORKER_PORT` aligns with this value. Do not duplicate the literal `37777` in any template — always reference `{{ .Values.worker.port }}`.

**`ingress.yaml`** — standard nginx Ingress with TLS:
```yaml
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "claude-mem.fullname" . }}
  annotations: {{- toYaml .Values.ingress.annotations | nindent 4 }}
spec:
  ingressClassName: {{ .Values.ingress.className }}
  tls: {{- toYaml .Values.ingress.tls | nindent 4 }}
  rules:
    {{- range .Values.ingress.hosts }}
    - host: {{ .host }}
      http:
        paths:
          {{- range .paths }}
          - path: {{ .path }}
            pathType: {{ .pathType }}
            backend:
              service:
                name: {{ include "claude-mem.fullname" $ }}
                port: { number: {{ $.Values.worker.port }} }
          {{- end }}
    {{- end }}
{{- end }}
```

**`cronjob-backup.yaml`** — runs `pg_dump` against the chart's Postgres (bundled or external) and uploads to S3. Skipping this template would ship a non-functional `backup.enabled` flag.

```yaml
{{- if .Values.backup.enabled }}
apiVersion: batch/v1
kind: CronJob
metadata:
  name: {{ include "claude-mem.fullname" . }}-backup
spec:
  schedule: {{ .Values.backup.schedule | quote }}
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: backup
              image: {{ .Values.backup.image }}
              env:
                - name: PGPASSWORD
                  valueFrom:
                    secretKeyRef: { name: {{ include "claude-mem.dbSecretName" . }}, key: password }
                - name: AWS_ACCESS_KEY_ID
                  valueFrom: { secretKeyRef: { name: {{ .Values.backup.existingSecret }}, key: AWS_ACCESS_KEY_ID } }
                - name: AWS_SECRET_ACCESS_KEY
                  valueFrom: { secretKeyRef: { name: {{ .Values.backup.existingSecret }}, key: AWS_SECRET_ACCESS_KEY } }
              command:
                - sh
                - -c
                - |
                  set -euo pipefail
                  ts=$(date -u +%Y%m%dT%H%M%SZ)
                  out=/tmp/claude-mem-${ts}.sql.gz
                  pg_dump -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" --no-owner --clean --if-exists \
                    | gzip -9 > "$out"
                  aws s3 cp "$out" "s3://{{ .Values.backup.s3.bucket }}/{{ .Values.backup.s3.prefix }}claude-mem-${ts}.sql.gz" \
                    {{- with .Values.backup.s3.endpoint }} --endpoint-url {{ . | quote }} {{- end }} \
                    --region {{ .Values.backup.s3.region | quote }}
              resources: {{ toYaml .Values.backup.resources | nindent 16 }}
{{- end }}
```

Restore path is operator-driven (out of scope for v1 chart): `aws s3 cp` the desired snapshot, `gunzip | psql` into a fresh database. Document this in `NOTES.txt` so users know what to do, even if the chart doesn't automate it.

**Prerequisites** (cluster-level, installed once):
- nginx-ingress controller: `helm install ingress-nginx ingress-nginx/ingress-nginx`
- cert-manager: `helm install cert-manager jetstack/cert-manager --set installCRDs=true`
- ClusterIssuer pointing at Let's Encrypt (HTTP-01 or Cloudflare DNS-01 challenge)

---

## Phase 8: Developer Onboarding

### `scripts/team-setup.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

while [[ $# -gt 0 ]]; do
  case $1 in
    --url)  URL="$2"; shift 2;;
    --key)  KEY="$2"; shift 2;;
    *)      echo "Unknown arg: $1"; exit 1;;
  esac
done

[[ -z "${URL:-}" ]] && { echo "Usage: $0 --url <url> --key <key>"; exit 1; }
[[ -z "${KEY:-}" ]] && { echo "Usage: $0 --url <url> --key <key>"; exit 1; }

npx claude-mem install

jq --arg url "$URL" --arg key "$KEY" \
  '. + {"CLAUDE_MEM_REMOTE_URL": $url, "CLAUDE_MEM_API_KEY": $key}' \
  ~/.claude-mem/settings.json > /tmp/cm-settings.json && \
  mv /tmp/cm-settings.json ~/.claude-mem/settings.json

echo "✓ claude-mem configured to use $URL"
echo "  Restart Claude Code to apply."
```

### Admin API key management

```bash
# Add/update keys (store in Secret, not Deployment env)
kubectl create secret generic claude-mem-api-keys \
  --from-literal=api-keys="alice:key-abc,bob:key-def,carol:key-ghi" \
  --dry-run=client -o yaml | kubectl apply -f -
```

### Local data migration

Out of scope for v1. Local SQLite history stays on the developer's machine and remains accessible via existing local tooling; the team server starts empty for each new user. Cross-import can be revisited later if there's demand.

---

## Complete File List

### New files

```
Dockerfile
.github/workflows/docker.yml
scripts/team-setup.sh
src/services/database/DbAdapter.ts
src/services/database/SqliteAdapter.ts
src/services/database/PostgresAdapter.ts
src/services/database/AdapterFactory.ts
src/services/database/migrations/postgres-schema.sql
src/services/database/migrations/v33-user-namespacing/sqlite.sql
src/services/database/migrations/v33-user-namespacing/postgres.sql
src/services/worker/http/middleware/auth.ts
src/services/worker/http/middleware/userContext.ts
helm/claude-mem/Chart.yaml
helm/claude-mem/values.yaml
helm/claude-mem/templates/_helpers.tpl
helm/claude-mem/templates/deployment.yaml
helm/claude-mem/templates/service.yaml
helm/claude-mem/templates/serviceaccount.yaml
helm/claude-mem/templates/configmap.yaml
helm/claude-mem/templates/secret.yaml
helm/claude-mem/templates/pvc.yaml
helm/claude-mem/templates/ingress.yaml
helm/claude-mem/templates/cronjob-backup.yaml
helm/claude-mem/templates/NOTES.txt
helm/claude-mem/templates/chroma/deployment.yaml
helm/claude-mem/templates/chroma/service.yaml
helm/claude-mem/templates/chroma/pvc.yaml
```

### Modified files

```
package.json                                           — bump engines.bun to >=1.1.30
.dockerignore                                          — expand exclusions
src/shared/SettingsDefaultsManager.ts                  — 5 new settings + rate-limit setting
src/shared/worker-utils.ts                             — getSettingValue(), buildWorkerUrl(), workerHttpRequest(), ensureWorkerRunning()
src/services/sqlite/Database.ts                        — use DbAdapter via AdapterFactory
src/services/sqlite/migrations.ts                       — legacy monolith; convert to DbAdapter or delete if fully superseded by migrations/runner.ts
src/services/sqlite/migrations/runner.ts               — async, DbAdapter, structural rewrite (engine-aware bootstrap + versioned migrations)
src/services/sqlite/SessionStore.ts                    — async (~246 call sites)
src/services/sqlite/SessionSearch.ts                   — async + PostgreSQL FTS branch
src/services/sqlite/PendingMessageStore.ts             — async
src/services/sqlite/transactions.ts                    — async
src/services/sqlite/observations/{store,get,recent,files}.ts
src/services/sqlite/prompts/{store,get}.ts
src/services/sqlite/sessions/{create,get}.ts
src/services/sqlite/summaries/{store,get,recent}.ts
src/services/sqlite/timeline/queries.ts
src/services/sqlite/import/bulk.ts
src/services/worker/DatabaseManager.ts                 — swap bun:sqlite import for DbAdapter
src/services/worker/PaginationHelper.ts                — swap bun:sqlite import for DbAdapter
src/services/worker/search/strategies/SQLiteSearchStrategy.ts  — await SessionSearch calls
src/services/worker/search/strategies/HybridSearchStrategy.ts  — audit + await
src/services/worker/search/SearchOrchestrator.ts       — audit + await
src/services/server/Server.ts                          — register auth + rate-limit middleware; gate /api/version behind auth
src/services/worker/http/routes/*.ts                   — add await to store/search calls; thread req.userId through INSERT/SELECT paths
src/cli/claude-md-commands.ts                          — convert to remote-aware path (DbAdapter or HTTP)
src/services/infrastructure/ProcessManager.ts          — hard-disable in PG mode (early return)
src/services/infrastructure/CleanupV12_4_3.ts          — hard-disable in PG mode
src/services/infrastructure/WorktreeAdoption.ts        — hard-disable in PG mode
```

---

## Verification

### Automated tests (per phase)

| Phase | Required tests                                                                                                                                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Unit tests for `DbAdapter` against both `SqliteAdapter` and `PostgresAdapter` (testcontainers): `all/get/run` semantics, multi-statement `exec`, transaction commit/rollback, concurrent transaction serialization (mutex). |
| 1     | Unit tests for `convertPlaceholders`: bare `?`, `?` inside `'...'`, `'...''...?'`, `$$...?...$$`, mixed `?` + literal `$1`, no `?`.                                                                                         |
| 2     | Existing SQLite-backed integration tests must pass after the async sweep (no behavior change in SQLite mode).                                                                                                               |
| 3     | Migration runner: idempotent re-run on both engines; `postgres-schema.sql` applied once produces same row counts as a fresh schema run.                                                                                     |
| 3     | FTS parity test: same query string returns the same observation IDs from SQLite FTS5 and PostgreSQL `tsvector` (sample corpus).                                                                                             |
| 4     | Migration v33 idempotency, both engines. Read isolation: alice's reads must not return bob's rows.                                                                                                                          |
| 5     | Auth middleware: timing-safe equality (verify constant-time even on length mismatch); rate-limit triggers at threshold; bypass when `CLAUDE_MEM_API_KEYS` empty.                                                            |
| 6     | `worker-utils.ts`: `ensureWorkerRunning()` returns true without spawning when `CLAUDE_MEM_REMOTE_URL` set; `workerHttpRequest()` injects `Authorization` header when `CLAUDE_MEM_API_KEY` set.                              |
| 7     | `helm lint` + `helm template` smoke test in CI.                                                                                                                                                                             |

### Manual smoke tests

```bash
# 1. SQLite mode unchanged
npm run build-and-sync
# start worker locally, run a Claude Code session, verify observations stored

# 2. PostgreSQL mode local
docker run -d --name pgtest \
  -e POSTGRES_DB=claude_mem -e POSTGRES_USER=claude_mem -e POSTGRES_PASSWORD=test \
  -p 5432:5432 postgres:16
CLAUDE_MEM_DB_TYPE=postgres \
CLAUDE_MEM_DATABASE_URL=postgres://claude_mem:test@localhost:5432/claude_mem \
  bun plugin/scripts/worker-service.cjs start
# verify /api/health, store observation, search it back

# 3. Docker build
docker build -t claude-mem:test .

# 4. Helm lint
helm lint helm/claude-mem/

# 5. Helm template smoke-test
helm template test helm/claude-mem/ \
  --set auth.keys.alice=testkey \
  --set ingress.enabled=true \
  --set "ingress.hosts[0].host=mem.company.com" \
  --set "ingress.hosts[0].paths[0].path=/" \
  --set "ingress.tls[0].secretName=claude-mem-tls" \
  --set "ingress.tls[0].hosts[0]=mem.company.com"

# 6. Kind cluster e2e
kind create cluster
helm install claude-mem helm/claude-mem/ \
  --set database.type=postgres \
  --set auth.keys.alice=testkey123
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=claude-mem --timeout=300s
kubectl port-forward svc/claude-mem 37777:37777 &
curl -H "Authorization: Bearer testkey123" http://localhost:37777/api/health

# 7. Remote mode client
CLAUDE_MEM_REMOTE_URL=http://localhost:37777 \
CLAUDE_MEM_API_KEY=testkey123 \
  bun plugin/scripts/worker-service.cjs start  # should NOT start local worker
# start Claude Code session — verify observations appear in port-forwarded server
```
