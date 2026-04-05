# ADR 0006: Deploy and Publish Eval + Promotion Gates

## Status
Accepted

## Context
Phase 2 requires promotion flow safety beyond static linting. Harbor needs deterministic deploy/publish quality gates that can stop unsafe releases and produce auditable gate metadata.

## Decision
- Extend deploy/publish outputs with typed gate metadata: `evalGate`, `promotionGate`, and `blockedReasons`.
- Run an eval smoke gate and a GitHub-style promotion check gate for deploy and publish paths.
- Keep lint as first gate; when lint blocks, eval/promotion gates are marked `skipped` and promotion is blocked.
- Block promotion on failed eval or failed promotion checks, and record reasons (`lint`, `eval`, `promotion`) in response payloads.

## Consequences
- Promotion decisions are explicit and machine-readable for UI, CI, and audit surfaces.
- Harbor can integrate real GitHub checks/eval runners later without API contract changes.
- Deploy/publish logic becomes stricter, increasing reliability at the cost of additional gate orchestration.
