# Evaluator Calibration

Harbor treats evaluator calibration as a deploy-time safety gate, not an optional report.

## Artifacts
- [`/Users/james/Documents/GitHub/harbor/docs/evaluator/rubric.json`](/Users/james/Documents/GitHub/harbor/docs/evaluator/rubric.json): active rubric thresholds and last calibration timestamp.
- [`/Users/james/Documents/GitHub/harbor/docs/evaluator/benchmarks/shared-benchmark.json`](/Users/james/Documents/GitHub/harbor/docs/evaluator/benchmarks/shared-benchmark.json): shared benchmark observations used to compute agreement/drift.
- [`/Users/james/Documents/GitHub/harbor/docs/evaluator/reports/latest.json`](/Users/james/Documents/GitHub/harbor/docs/evaluator/reports/latest.json): latest generated calibration report.
- [`/Users/james/Documents/GitHub/harbor/docs/evaluator/reports/history/index.json`](/Users/james/Documents/GitHub/harbor/docs/evaluator/reports/history/index.json): rolling history index for calibration snapshots.

## Gate
Run `pnpm evaluator:check` to:
1. Validate rubric and benchmark files.
2. Compute agreement and drift scores.
3. Regenerate latest report and history.
4. Fail when rubric age exceeds policy or drift thresholds are violated.
