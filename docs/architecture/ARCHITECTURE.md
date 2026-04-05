# Harbor Architecture Map

## Layering
1. `apps/web`: Next.js UI, builder, run dashboards, typed caller surfaces.
2. `apps/worker`: Inngest handlers, run isolation lifecycle, orchestration execution.
3. `packages/api`: tenancy-scoped tRPC routers and deployment/run contracts.
4. `packages/engine`: runtime state machine (`plan -> execute -> verify -> fix`).
5. `packages/harness`: linting, prompt assembly, guardrail and remediation logic.
6. `packages/memu`: managed memU adapter, policy validation, retrieval/writeback contracts.
7. `packages/database`: run/workflow persistence abstractions and Postgres/in-memory implementations.
8. `packages/observability`: run tracing model and telemetry wrappers.

## Dependency Direction
- Apps depend on packages; packages do not depend on apps.
- `@harbor/api` depends on `@harbor/engine` and `@harbor/harness` contracts.
- `@harbor/engine` depends on harness types but not API/router concerns.
- `@harbor/database` and `@harbor/memu` are adapter layers consumed by apps/engine.
- `@harbor/observability` is shared and dependency-light.

## Runtime Boundaries
- API boundary: all run/deploy operations enter through tenancy-scoped tRPC procedures.
- Execution boundary: runner enforces stage transitions and lint gates.
- Memory boundary: memU operations are policy-gated and retention-aware.
- Isolation boundary: each run is worktree-bound and has ephemeral observability lifecycle.

## Legibility Rules
- Every workspace keeps a local `README.md` with purpose and entrypoints.
- Strategy and architecture documents are indexed in `docs/README.md`.
- Policy and naming invariants are machine-checked via `pnpm legibility:check`.
