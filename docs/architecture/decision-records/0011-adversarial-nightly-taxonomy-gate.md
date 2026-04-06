# ADR 0011: Adversarial Nightly Scheduling and Taxonomy Gate

## Status
Accepted

## Context
Phase 2.8 requires adversarial suites beyond deploy-time smoke checks. Harbor needs a deterministic nightly path that continuously validates fixture workflows and emits structured vulnerability taxonomy artifacts that can block unsafe changes.

## Decision
- Add a scheduled worker function (`cron: 0 3 * * *`) to run nightly adversarial scans against deterministic fixture workflows.
- Extend adversarial suite outputs with taxonomy counts (`byCategory`, `byScenario`, severity totals).
- Require API adversarial gate payloads to include taxonomy metadata.
- Add a repository drift gate (`pnpm adversarial:check`) that:
  - rebuilds harness deterministically,
  - re-runs nightly fixture suites,
  - updates `docs/adversarial/reports/latest.json` + history,
  - fails closed if any critical findings are detected.

## Consequences
- Nightly adversarial behavior is no longer implicit; it is machine-checkable and traceable.
- Vulnerability trends become queryable by category and scenario instead of free-form findings only.
- Critical adversarial regressions now fail CI/local `pnpm check` early, improving security posture with modest additional check time.
