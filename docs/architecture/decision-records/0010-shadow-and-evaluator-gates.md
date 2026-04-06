# ADR 0010: Shadow Regression and Evaluator Calibration Gates

## Status
Accepted

## Context
Phase 2.8 adds higher-signal harness safeguards: shadow/canary rollout comparison and evaluator calibration drift detection. These controls must be enforced through existing deploy/publish gate contracts without introducing a runtime rewrite.

## Decision
- Extend deploy/publish/open-promotion outputs with `shadowGate` metadata and block reason `shadow`.
- Require eval gate outputs to include `calibration` metadata (`rubricVersion`, agreement/drift scores, thresholds, drift flag).
- Wire default dependency behavior to load evaluator rubric policy and compute benchmark agreement per gate execution.
- Add a repository-level `pnpm evaluator:check` drift gate that validates rubric freshness, computes calibration reports, and writes rolling history artifacts under `docs/evaluator/reports`.

## Consequences
- Promotion decisions are now attributable to both shadow regression checks and evaluator rubric provenance.
- Monthly evaluator calibration drift is machine-enforced in the same cadence as existing docs/vision/legibility/standards gates.
- Slightly stricter deploy gates may block publication when evaluator calibration drifts, increasing reliability at the cost of additional maintenance on rubric freshness.
