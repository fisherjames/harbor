# Phase 3 Production Runbook

<!-- RUNBOOK_METADATA_BEGIN -->
{
  "version": 1,
  "generatedAt": "2026-04-06T16:17:30.849Z",
  "generatedBy": "scripts/runbook-drift-check.mjs",
  "phase": "phase-3",
  "readinessStatus": "ready",
  "attentionFlags": [],
  "sourceReports": {
    "evaluator": "2026-04-06T16:04:40.714Z",
    "adversarial": "2026-04-06T16:04:42.106Z",
    "inference": "2026-04-06T16:04:42.426Z",
    "teamStandards": "unknown"
  },
  "phase3Features": {
    "total": 5,
    "complete": 5,
    "inProgress": 0,
    "planned": 0
  },
  "signals": {
    "evaluatorStatus": "passed",
    "evaluatorDriftDetected": false,
    "adversarialCriticalFindings": 0,
    "adversarialWarningFindings": 1,
    "inferenceStatus": "aligned",
    "inferenceCriticalCount": 0,
    "inferenceWarningCount": 0,
    "inferenceLintHintCount": 7,
    "standardsStatus": "pass",
    "standardsFailureCount": 0,
    "standardsWarningCount": 0
  }
}
<!-- RUNBOOK_METADATA_END -->

## Purpose

Provide a deterministic on-call and operator flow for Harbor Phase 3 reliability incidents using only repository artifacts and machine-generated reports.

## Readiness Snapshot

- Phase tracker status: `in_progress`
- Phase 3 features complete: `5/5`
- Evaluator status: `passed` (driftDetected=`false`)
- Adversarial findings: critical=`0`, warning=`1`
- Inference drift: status=`aligned`, critical=`0`, warnings=`0`, lintHints=`7`
- Team standards: status=`pass`, failures=`0`, warnings=`0`
- Runbook readiness: `ready`

## Source Signals

| Signal | Source | Value |
| --- | --- | --- |
| Evaluator calibration | `docs/evaluator/reports/latest.json` | status=`passed` |
| Adversarial nightly taxonomy | `docs/adversarial/reports/latest.json` | critical=`0`, warning=`1` |
| Inference drift + suggestions | `docs/inference/reports/latest.json` | status=`aligned`, critical=`0` |
| Team standards encoding | `docs/team-standards/reports/latest.json` | status=`pass`, failures=`0` |

## Incident Triage Flow

1. Confirm scope and identity: tenant, workspace, workflow, run ID.
2. Open run timeline and validate run status transitions (`queued -> running -> completed/needs_human/failed`).
3. Inspect run artifacts from the decision matrix below.
4. If dead-letter or confidence gate exists, replay from source input using pinned workflow version.
5. Run drift and quality gates before promotion:
   - `pnpm runbook:check`
   - `pnpm check`
6. If any critical drift or lint remains, halt deploy/publish and apply Harness Resolution Steps.

## Run Artifact Decision Matrix

| Artifact | Interpretation | Operator action |
| --- | --- | --- |
| `stuck-run-recovery` | Automatic stale-run recovery was triggered and escalated safely. | Review reason, validate replay eligibility, and either replay or close with operator note. |
| `stuck-run-dead-letter` | Recovery failed; run moved to dead-letter with replay reference. | Replay from source input using pinned workflow version; inspect cause before re-promote. |
| `replay-bundle-manifest` | Replay parity baseline metadata is available for deterministic comparison. | Use run compare to confirm parity and inspect divergence taxonomy if parity breaks. |
| `replay-divergence-taxonomy` | Replay drift categories were detected for the run. | Treat non-zero counts as reliability regression; feed findings into harness remediation. |
| `confidence-gate` | A stage output fell below confidence threshold and raised needs_human. | Resolve uncertainty with explicit acceptance criteria and replay if necessary. |
| `memory-conflict-latest` | memU conflict reconciliation recorded dropped/contested memory items. | Review trust/conflict metrics and adjust memory policy or writeback controls. |

## Harness Resolution Steps

1. Set a non-empty systemPrompt with explicit instructions.
2. Include role definitions, constraints, and verification intent in the prompt.
3. Reject deployment or execution if systemPrompt is empty after trimming.
4. Incorporate guardrail language to specify non-negotiable constraints.
5. Document tool and data boundaries clearly within the system prompt.
6. Keep constraints concise and testable.
7. Define explicit verification expectations in the system prompt.
8. Add PASS/FAIL acceptance criteria for outputs.
9. Ensure verification language is clear and actionable.
10. Add a tool node with sideEffectMode='propose' and matching phaseGroup before commit nodes.
11. Keep commit nodes with sideEffectMode='commit' and the same phaseGroup.
12. Emit preview artifact hash prior to executing commit actions.

## Verification Commands

```bash
pnpm runbook:check
pnpm replay:verify
pnpm features:check
pnpm check
```

## Escalation and Replay Checklist

1. Capture escalation reason and attach it to run metadata.
2. Use replay from source input with workflow version pinning.
3. Compare base vs replay run (status, tokens, stage output deltas, artifact deltas).
4. Ensure replay-divergence taxonomy is resolved before promotion.
5. Record post-incident remediations in docs and standards artifacts.

## Notes

- This runbook is generated by `scripts/runbook-drift-check.mjs`.
- Do not edit generated sections manually; update source reports/contracts and rerun the gate.
