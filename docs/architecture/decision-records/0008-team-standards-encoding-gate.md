# ADR 0008: Team Standards Encoding Gate

## Status
Accepted

## Context
As Harbor scales, tacit review expectations risk becoming inconsistent across engineers and coding agents. Martin Fowler's team standards guidance emphasizes encoding standards into explicit, task-scoped instructions that are calibrated over time.

## Decision
- Add a project-scoped standards instruction set under `docs/team-standards` for generation, refactoring, security, and review tasks.
- Add `docs/strategy/team-standards-contract.json` as the machine-readable contract for instruction anatomy and scope boundaries.
- Add `pnpm standards:check` (`scripts/standards-encoding-check.mjs`) to enforce:
  - required standards files,
  - required headings and severity categories,
  - explicit scope boundaries,
  - calibration history presence,
  - prohibition of global rules/skills references,
  - rolling history trend detection for repeated warning/failure signals.
- Include standards drift validation in the root `pnpm check` chain and docs cadence requirements.
- Generate `docs/team-standards/reports/remediation.json` with an auto-built `## Harness Resolution Steps` section for repeated drift trends.

## Consequences
- Team guidance becomes executable and consistently reusable by humans and agents.
- Standards updates now require small ongoing maintenance and calibration entries.
- Drift from project-scoped, enforceable instructions is caught before merge.
- Repeated drift patterns are surfaced early with machine-readable remediation prompts before they become chronic.
