# Phase 3: Polished Production

## Purpose
Harden Harbor for operational reliability, production observability, and tenancy-safe recovery behavior without breaking existing MVP contracts.

## Scope
- Reliability first: run lifecycle resilience, stuck-run automation, replayability, and operator controls.
- Keep strict typing and 100% unit coverage across touched workspaces.
- Keep every reliability action trace-visible and audit-reconstructable.

## Progress Snapshot (2026-04-06)
- Reliability stream is in progress with Stream A now implemented.
- Implemented this slice:
1. Added typed `listStuckRuns` contract in `@harbor/database` for cross-tenant stuck-run scanning.
2. Added `runStuckRunRecoveryScan` in `@harbor/worker` with scheduled execution (`*/10 * * * *`).
3. Added automatic safe recovery path: stale `running` runs are escalated to `needs_human` with recovery artifacts.
4. Added dead-letter fallback for irrecoverable stuck runs (`failed` status + `stuck-run-dead-letter` artifact + replay reference).
5. Added deterministic stuck-run recovery scope policies (`HARBOR_STUCK_RUN_POLICIES`) with tenant/workspace matching.
6. Added typed `replayRun` API entrypoint and web action wiring to replay from source run input with replay linkage artifacts.
7. Added full unit coverage for new branches in database, API, web, and worker modules.
8. Added a machine-checked feature catalog (`docs/features`) and `pnpm features:check` drift gate to keep implemented capabilities explicit.
9. Added a typed benchmark-to-production bridge contract so deploy/publish/promotion flows return one unified harness progression path (lint → eval → promotion → adversarial → shadow) with explicit next action.
10. Added Stream B reliability observability surfaces: run-health facets, per-workflow P95/failure taxonomy summaries, and typed reliability budget alert hook payload rendering on the home dashboard.
11. Added full branch coverage tests for Stream B observability contracts in `@harbor/observability`.
12. Added Stream C operator UX surfaces: version-aware run compare, guided onboarding template run path, and memory explorer snapshot over recent run artifacts.
13. Added typed `compareRuns` API contract with full branch coverage and UI integration on run detail pages.

## Streams

### Stream A: Reliability Hardening
Owner: `packages/database` + `apps/worker` + `packages/engine`

Tasks:
1. Completed: dead-letter capture for irrecoverable run failures with replay references.
2. Completed: deterministic stuck-run detector policy controls by tenant/workspace.
3. Completed: safe replay entrypoint from recovery artifacts.

Definition of done:
1. Stuck runs are recovered or dead-lettered automatically.
2. Recovery actions are auditable and idempotent.
3. Replay path can be started directly from recovery metadata.

### Stream B: Operational Observability
Owner: `packages/observability` + `apps/web`

Tasks:
1. Completed: run-health dashboard facets for stuck, recovered, dead-letter, and replay parity.
2. Completed: per-workflow P95 latency and failure-taxonomy views.
3. Completed: alert hook payload generation for sustained reliability budget breaches.

Definition of done:
1. Reliability KPIs are queryable by tenant/workspace/workflow.
2. On-call can triage from one run timeline.

### Stream C: Product Polishing
Owner: `apps/web` + `packages/api`

Tasks:
1. Completed: run diffing and version-aware compare surfaces.
2. Completed: guided onboarding template with harness-safe defaults and one-click run path.
3. Completed: memory explorer conflict/trust snapshot over recent run artifacts.

Definition of done:
1. New users can run a template workflow in one guided path.
2. Operators can compare behavior across versions without raw log parsing.

## Exit Criteria
1. Phase 3 reliability tasks are implemented with strict typing and 100% unit coverage.
2. Stuck-run + dead-letter workflows are enforced and trace-visible.
3. Production runbooks can be generated from artifacts and docs without manual tribal knowledge.
