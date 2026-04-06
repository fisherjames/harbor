# Harbor Feature Catalog

This catalog is the explicit source of truth for implemented product/harness capabilities and where each capability is enforced in code.

## How To Use
1. Treat `docs/features/harness-features.json` as the machine-readable contract.
2. Keep each feature mapped to evidence paths and code assertions.
3. Run `pnpm features:check` and `pnpm check` after every feature-level change.
4. Do not mark a feature `complete` unless all evidence and assertions pass.

## Current Feature Set
- `typed-trpc-contract-surface`
- `staged-runtime-plan-execute-verify-fix`
- `harness-lint-remediation-loop`
- `memu-retrieval-writeback-policy`
- `workflow-builder-version-lifecycle`
- `deploy-gates-eval-shadow-adversarial-github`
- `policy-bundle-signing-provenance`
- `deterministic-replay-parity`
- `confidence-gated-autonomy`
- `two-phase-side-effect-enforcement`
- `evaluator-calibration-gate`
- `adversarial-smoke-nightly-taxonomy-gate`
- `worktree-bound-run-isolation`
- `ephemeral-observability-envelope`
- `memory-trust-conflict-metrics`
- `stuck-run-detection-recovery`
- `benchmark-to-production-bridge`
- `machine-drift-gate-stack`

`machine-drift-gate-stack` now includes inference-assisted drift/lint/adversarial suggestions via `pnpm inference:check`.

## Cadence Rule
Update this catalog in the same PR as implementation changes so docs and harness behavior cannot drift.
