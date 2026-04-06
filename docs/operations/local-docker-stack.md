# Local Docker Stack

This guide runs Harbor as a full local stack with real model provider wiring.
The Docker image initializes a local git snapshot so `git worktree add/remove` isolation works inside containers.

## Services

- `web`: Harbor UI/API (`http://localhost:${HARBOR_WEB_PORT:-3000}`)
- `worker`: Inngest function server (`http://localhost:${HARBOR_WORKER_PORT:-8289}/api/inngest`)
- `inngest`: Inngest dev control plane (`http://localhost:${HARBOR_INNGEST_PORT:-8288}`)
- `postgres`: run persistence (`localhost:${HARBOR_POSTGRES_PORT:-5432}`)
- `redis`: queue/cache dependency (`localhost:${HARBOR_REDIS_PORT:-6379}`)
- `memu-mock`: local memU-compatible HTTP service (`http://localhost:${HARBOR_MEMU_PORT:-8081}`)

## Setup

1. Copy provider env template:

```bash
cp .env.docker.example .env
```

2. Configure provider/env values in `.env`:
- Set `HARBOR_MODEL_PROVIDER=openai` and `OPENAI_API_KEY=<your key>` for real OpenAI runs.
- Set `HARBOR_MODEL_PROVIDER=echo` for local deterministic runs without external model calls.
- Keep `MEMU_ENDPOINT=http://memu-mock:8080` to use the included local memU-compatible mock.
- Optional GitHub promotion provider: set `GITHUB_TOKEN` and `GITHUB_PROMOTION_REPOSITORY`.
- Optional Clerk browser auth key: set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.
- Keep `HARBOR_RUN_ISOLATION_MODE=git-worktree` to enforce git-worktree-bound runs (default).

3. Optional: override host ports when defaults are occupied:

```bash
HARBOR_WEB_PORT=3005
HARBOR_WORKER_PORT=8389
```

4. Start stack:

```bash
docker compose up --build -d
```

5. Watch logs:

```bash
docker compose logs -f web worker inngest
```

## Health Checks

- Web: `curl -sf http://localhost:${HARBOR_WEB_PORT:-3000} >/dev/null`
- Worker: `curl -sf http://localhost:${HARBOR_WORKER_PORT:-8289}/healthz`
- memU mock: `curl -sf http://localhost:${HARBOR_MEMU_PORT:-8081}/v1/health`
- Inngest endpoint target: `http://worker:8289/api/inngest`

Use the worker health payload to verify effective provider wiring (`requested` vs `effective` model provider, memU endpoint, database branch).
Each run also records `run-isolation-session` artifacts including worktree path and isolation mode.

## Teardown

```bash
docker compose down
```

For a clean reset including volumes:

```bash
docker compose down -v
```
