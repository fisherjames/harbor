# Harbor Getting Started

<!-- DOCS_CADENCE_METADATA_BEGIN -->
{
  "currentPhase": "phase-2",
  "harnessRules": ["HAR001", "HAR002", "HAR003", "HAR004", "HAR005"],
  "milestones": [
    { "id": "phase-1", "status": "complete", "docsVerified": true },
    { "id": "phase-2", "status": "in_progress", "docsVerified": true },
    { "id": "phase-3", "status": "planned", "docsVerified": false },
    { "id": "phase-4", "status": "planned", "docsVerified": false },
    { "id": "phase-5", "status": "planned", "docsVerified": false }
  ]
}
<!-- DOCS_CADENCE_METADATA_END -->

## Quick Start

1. Install dependencies: `pnpm install`.
2. Run all quality gates: `pnpm check`.
3. Start development services: `pnpm dev`.
4. Validate docs/vision contracts before milestone changes:
- `pnpm vision:check`
- `pnpm docs:check`
- `pnpm legibility:check`

## Harness + Docs Cadence

- Every milestone change must update this document metadata and `docs/strategy/phase-tracker.json` in the same PR.
- Keep harness rules (`HAR001`-`HAR005`) aligned with this guide and runtime behavior.
- Keep linter remediation language aligned with the runtime `Harness Resolution Steps` section.
- Keep runtime guarantees documented: worktree-bound execution, per-run ephemeral observability, and run idempotency key behavior.
- Keep promotion guarantees documented: deploy/publish must report eval gate and GitHub promotion check outcomes.
- Keep repository legibility guarantees documented: docs index, workspace READMEs, and naming conventions must pass `pnpm legibility:check`.

## Milestone Verification

1. Update phase status in `docs/strategy/phase-tracker.json`.
2. Update `DOCS_CADENCE_METADATA` in this document to match phase statuses and harness rules.
3. Ensure completed/in-progress phases set `docsVerified: true`.
4. Run `pnpm check` and confirm both vision and docs drift gates pass.
5. Confirm the agent legibility gate passes (`pnpm legibility:check`).
6. Add milestone evidence paths before marking phase complete.

## Phase Evidence Map

- `phase-1` (MVP Core): runtime, run dashboard, persistence foundations.
- `phase-2` (MVP Complete): visual builder, version lifecycle, runtime safety policies.
- `phase-2` (MVP Complete): visual builder, version lifecycle, runtime safety policies, and agent legibility drift gates.
- `phase-3` (Polished Production): idempotency hardening, replay tooling, operational dashboards.
- `phase-4` (Enterprise Foundation): SAML/SCIM, immutable audit exports, policy governance.
- `phase-5` (Full Enterprise Product): self-host packaging, HA topology, contract-grade SLO reporting.
