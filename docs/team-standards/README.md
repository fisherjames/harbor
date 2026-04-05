# Team Standards Instructions

These files encode Harbor's tacit team standards into executable, versioned artifacts.

## Purpose
- Keep AI-assisted output consistent regardless of who is prompting.
- Encode standards at generation, refactoring, security, and review points.
- Keep instructions small, single-purpose, and easy to evolve via PR.
- Keep standards project-scoped; never depend on global rules or skills.

## Instruction Set
- `generation.md`: standards for creating new code paths.
- `refactoring.md`: standards for changing existing code safely.
- `security.md`: standards for threat-model-driven checks.
- `review.md`: standards for structured pull request review.
- `har-rule-coverage.json`: standards-to-HAR rule coverage matrix and template target mapping.
- `har-rule-examples.json`: known-good HAR rule examples tied to concrete files/tests.

## Calibration
- `calibration.md` tracks lightweight alignment cadence and change criteria.

## Validation
- `pnpm standards:check` validates instruction anatomy and scope limits.
- `pnpm standards:check` updates `docs/team-standards/reports/latest.json` with the latest drift report.
