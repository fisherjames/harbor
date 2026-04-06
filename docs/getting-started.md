# Harbor Getting Started

<!-- DOCS_CADENCE_METADATA_BEGIN -->
{
  "currentPhase": "phase-3",
  "harnessRules": ["HAR001", "HAR002", "HAR003", "HAR004", "HAR005"],
  "milestones": [
    { "id": "phase-1", "status": "complete", "docsVerified": true },
    { "id": "phase-2", "status": "complete", "docsVerified": true },
    { "id": "phase-2.5", "status": "complete", "docsVerified": true },
    { "id": "phase-2.6", "status": "complete", "docsVerified": true },
    { "id": "phase-2.8", "status": "complete", "docsVerified": true },
    { "id": "phase-3", "status": "in_progress", "docsVerified": true },
    { "id": "phase-4", "status": "planned", "docsVerified": false },
    { "id": "phase-5", "status": "planned", "docsVerified": false }
  ]
}
<!-- DOCS_CADENCE_METADATA_END -->

## Quick Start

1. Install dependencies: `pnpm install`.
2. Copy env template and configure real providers: `cp .env.example .env`.
3. Configure Docker env: `cp .env.docker.example .env`.
4. Keep `HARBOR_RUN_ISOLATION_MODE=git-worktree` (default) so each run is bound to a git worktree.
5. Optional: override host ports in `.env` if defaults are busy (for example `HARBOR_WEB_PORT=3005`).
6. Start full local docker stack: `docker compose up --build -d`.
7. Run all quality gates: `pnpm check`.
8. Start development services (optional non-docker workflow): `pnpm dev`.
9. Validate docs/vision contracts before milestone changes:
- `pnpm vision:check`
- `pnpm docs:check`
- `pnpm runbook:check`
- `pnpm features:check`
- `pnpm legibility:check`
- `pnpm standards:check`
- `pnpm evaluator:check`
- `pnpm adversarial:check`
- `pnpm inference:check`

## Harness + Docs Cadence

- Every milestone change must update this document metadata and `docs/strategy/phase-tracker.json` in the same PR.
- Keep harness rules (`HAR001`-`HAR005`) aligned with this guide and runtime behavior.
- Keep linter remediation language aligned with the runtime `Harness Resolution Steps` section.
- Keep runtime guarantees documented: worktree-bound execution, per-run ephemeral observability, and run idempotency key behavior.
- Keep implemented feature inventory synchronized in `docs/features/harness-features.json` and validate with `pnpm features:check`.
- Keep promotion guarantees documented: deploy/publish must report eval gate and GitHub promotion check outcomes.
- Keep benchmark-to-production bridge guarantees documented: deploy/publish/promotion APIs must return one unified gate progression path with explicit next action.
- Keep Phase 3 Production Runbook generated and current with `pnpm runbook:check`.
- Keep repository legibility guarantees documented: docs index, workspace READMEs, and naming conventions must pass `pnpm legibility:check`.
- Keep team standards encoding guarantees documented: instruction anatomy and calibration history must pass `pnpm standards:check`.
- Keep team standards drift report current at `docs/team-standards/reports/latest.json`.
- Keep team standards rolling history current at `docs/team-standards/reports/history/index.json` with retention policy.
- Keep team standards remediation report current at `docs/team-standards/reports/remediation.json` with `## Harness Resolution Steps`.
- Keep evaluator calibration report current at `docs/evaluator/reports/latest.json` and enforce monthly rubric freshness with `pnpm evaluator:check`.
- Keep adversarial nightly taxonomy report current at `docs/adversarial/reports/latest.json` and enforce critical-vulnerability blocking with `pnpm adversarial:check`.
- Keep inference drift + suggestion report current at `docs/inference/reports/latest.json` with `pnpm inference:check`; use `HARBOR_INFERENCE_GATE_MODE=enforce` when you want inference to block.

## Milestone Verification

1. Update phase status in `docs/strategy/phase-tracker.json`.
2. Update `DOCS_CADENCE_METADATA` in this document to match phase statuses and harness rules.
3. Ensure completed/in-progress phases set `docsVerified: true`.
4. Run `pnpm check` and confirm both vision and docs drift gates pass.
5. Confirm the agent legibility gate passes (`pnpm legibility:check`).
6. Confirm the team standards gate passes (`pnpm standards:check`).
7. Confirm evaluator calibration gate passes (`pnpm evaluator:check`).
8. Confirm adversarial nightly taxonomy gate passes (`pnpm adversarial:check`).
9. Add milestone evidence paths before marking phase complete.

## Phase Evidence Map

- `phase-1` (MVP Core): runtime, run dashboard, persistence foundations.
- `phase-2` (MVP Complete): visual builder, version lifecycle, deploy gates, and GitHub-backed promotion workflows.
- `phase-2.5` (Harness + Legibility Hardening): docs/index hardening, workspace legibility, repository map drift checks, and agent legibility gates.
- `phase-2.6` (Team Standards Encoding): Fowler-style standards files, HAR coverage/examples packs, calibration freshness checks, and CI-enforced standards drift checks.
- `phase-2.8` (Harness Principles Addendum): confidence-gated autonomy, two-phase side-effect protocol, deterministic replay bundles, shadow/canary harness rollout, evaluator calibration, adversarial suites, signed policy bundles, and memory trust/conflict controls.
- `phase-3` (Polished Production): idempotency hardening, stuck-run recovery automation, replay tooling, benchmark-to-production bridge unification, operational dashboards, and artifact-generated production runbooks.
- `phase-4` (Enterprise Foundation): SAML/SCIM, immutable audit exports, policy governance.
- `phase-5` (Full Enterprise Product): self-host packaging, HA topology, contract-grade SLO reporting.
