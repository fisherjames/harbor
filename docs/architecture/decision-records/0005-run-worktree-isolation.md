# ADR 0005: Worktree-Bound Runs with Ephemeral Observability

## Status
Accepted

## Context
Harbor needs stronger execution isolation and deterministic debugging for concurrent, autonomous runs.

## Decision
- Each workflow run is bound to a dedicated git worktree context.
- A run must be able to build and execute the full Harbor stack within that isolated context.
- Each run publishes telemetry to a run-scoped ephemeral observability envelope (collector, trace stream, and retention policy).
- Run cleanup must remove or expire worktree-bound runtime artifacts and ephemeral observability resources on completion/failure.

## Consequences
- Better run isolation, reproducibility, and incident forensics.
- Reduced cross-run interference and state leakage risk.
- Additional orchestration complexity for lifecycle setup/teardown and retention controls.
