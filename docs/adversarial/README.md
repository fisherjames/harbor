# Adversarial Nightly Taxonomy

Harbor runs deterministic adversarial suites in two modes:
1. `smoke` at deploy/publish gates.
2. `nightly` on a scheduled worker function for deeper coverage.

## Artifacts
- [`/Users/james/Documents/GitHub/harbor/docs/adversarial/workflows/nightly-fixtures.json`](/Users/james/Documents/GitHub/harbor/docs/adversarial/workflows/nightly-fixtures.json): deterministic nightly workflow fixtures.
- [`/Users/james/Documents/GitHub/harbor/docs/adversarial/reports/latest.json`](/Users/james/Documents/GitHub/harbor/docs/adversarial/reports/latest.json): latest taxonomy report.
- [`/Users/james/Documents/GitHub/harbor/docs/adversarial/reports/history/index.json`](/Users/james/Documents/GitHub/harbor/docs/adversarial/reports/history/index.json): rolling history index.

## Gate
Run `pnpm adversarial:check` to recompute nightly taxonomy from fixtures, refresh reports, and fail if critical findings are detected.
