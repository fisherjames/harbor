# Phase 3: Polished Production

## Purpose
Harden Harbor for operational reliability, production observability, and tenancy-safe recovery behavior without breaking existing MVP contracts.

## Scope
- Reliability first: run lifecycle resilience, stuck-run automation, replayability, and operator controls.
- Keep strict typing and 100% unit coverage across touched workspaces.
- Keep every reliability action trace-visible and audit-reconstructable.

## Progress Snapshot (2026-04-06)
- Reliability stream is in progress.
- Implemented this slice:
1. Added typed `listStuckRuns` contract in `@harbor/database` for cross-tenant stuck-run scanning.
2. Added `runStuckRunRecoveryScan` in `@harbor/worker` with scheduled execution (`*/10 * * * *`).
3. Added automatic safe recovery path: stale `running` runs are escalated to `needs_human` with recovery artifacts.
4. Added full unit coverage for new branches in database and worker modules.
5. Added a machine-checked feature catalog (`docs/features`) and `pnpm features:check` drift gate to keep implemented capabilities explicit.
6. Added a typed benchmark-to-production bridge contract so deploy/publish/promotion flows return one unified harness progression path (lint → eval → promotion → adversarial → shadow) with explicit next action.

## Streams

### Stream A: Reliability Hardening
Owner: `packages/database` + `apps/worker` + `packages/engine`

Tasks:
1. Add dead-letter capture for irrecoverable run failures with replay references.
2. Add deterministic stuck-run detector policy controls by tenant/workspace.
3. Add safe replay entrypoint from recovery artifacts.

Definition of done:
1. Stuck runs are recovered or dead-lettered automatically.
2. Recovery actions are auditable and idempotent.
3. Replay path can be started directly from recovery metadata.

### Stream B: Operational Observability
Owner: `packages/observability` + `apps/web`

Tasks:
1. Add run-health dashboard facets for stuck, recovered, dead-letter, and replay parity.
2. Add per-workflow P95 latency and failure-taxonomy views.
3. Add alert hooks for sustained reliability budget breaches.

Definition of done:
1. Reliability KPIs are queryable by tenant/workspace/workflow.
2. On-call can triage from one run timeline.

### Stream C: Product Polishing
Owner: `apps/web` + `packages/api`

Tasks:
1. Add run diffing and version-aware compare surfaces.
2. Add guided onboarding templates with harness-safe defaults.
3. Expose memory explorer conflict and trust views from existing artifacts.

Definition of done:
1. New users can run a template workflow in one guided path.
2. Operators can compare behavior across versions without raw log parsing.

## Exit Criteria
1. Phase 3 reliability tasks are implemented with strict typing and 100% unit coverage.
2. Stuck-run + dead-letter workflows are enforced and trace-visible.
3. Production runbooks can be generated from artifacts and docs without manual tribal knowledge.
