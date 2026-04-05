# Team Standards Calibration

## Cadence
- Recalibrate standards after notable incidents, repeated lint findings, or architecture policy changes.
- Run lightweight monthly review if no trigger event occurs.

## Trigger Signals
- Repeated PR comments on the same class of issue.
- Recurring gate failures from the same standards category.
- Drift between written standards and reviewer behavior.

## Calibration Steps
1. Gather examples from recent merged PRs and blocked PRs.
2. Identify ambiguous or missing standards in one instruction file.
3. Propose targeted updates via PR with concrete examples.
4. Re-run `pnpm standards:check` and `pnpm check` before merge.
5. Record outcomes in this file under "History".

## History
- 2026-04-05: Initial standards baseline added for Phase 2.6.
