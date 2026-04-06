# Inference Drift + Harness Suggestions

This section stores inference-assisted checks that complement deterministic machine gates.

## Command

- `pnpm inference:check`

## Modes

- `HARBOR_INFERENCE_GATE_MODE=report` (default): always produces a report and never blocks unless the request fails.
- `HARBOR_INFERENCE_GATE_MODE=enforce`: blocks when inference status is `drift` or critical drift findings are present.

## Inputs

- `docs/strategy/vision.md`
- `docs/getting-started.md`
- `docs/features/harness-features.json`
- `AGENTS.md`
- `packages/harness/src/rules/core-rules.ts`
- `docs/team-standards/reports/remediation.json`
- `packages/harness/src/adversarial.ts`
- `docs/adversarial/workflows/nightly-fixtures.json`

## Outputs

- `docs/inference/reports/latest.json`
- `docs/inference/reports/history/index.json`
- `docs/inference/reports/history/YYYY-MM-DD.json`

## Cost Tracking

The report captures token usage and estimated cost using configurable rates:

- `HARBOR_INFERENCE_INPUT_COST_PER_1K`
- `HARBOR_INFERENCE_OUTPUT_COST_PER_1K`

Set these to your actual provider pricing for accurate cost accounting.
