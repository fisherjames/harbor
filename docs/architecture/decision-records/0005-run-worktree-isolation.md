# ADR 0005: Worktree-Bound Runs with Ephemeral Observability

## Status
Accepted

## Context
Harbor needs stronger execution isolation and deterministic debugging for concurrent, autonomous runs.

## Decision
- Each workflow run is bound to a dedicated git worktree context created via `git worktree add --detach <path> HEAD`.
- A run must be able to build and execute the full Harbor stack within that isolated context.
- Each run publishes telemetry to a run-scoped ephemeral observability envelope (collector, trace stream, and retention policy).
- Run cleanup must remove worktrees via `git worktree remove --force` and expire ephemeral observability resources on completion/failure.
- All runtime entrypoints (`apps/worker` and `apps/web`) must pass the same run-isolation manager into `createWorkflowRunner`.

## Consequences
- Better run isolation, reproducibility, and incident forensics.
- Reduced cross-run interference and state leakage risk.
- Additional orchestration complexity for lifecycle setup/teardown and retention controls.
