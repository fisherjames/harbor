# ADR 0004: Tool Call Budget Policy Enforcement

## Status
Accepted

## Context
Phase 2 requires safer tool orchestration. Permission scopes alone are insufficient without bounded call budgets.

## Decision
- Add `toolCallPolicy` to `tool_call` nodes with `timeoutMs`, `retryLimit`, and `maxCalls`.
- Add harness lint rule `HAR005` to warn when tool policy is missing or invalid.
- Persist a `tool-execution-policy` artifact at runtime for traceability.

## Consequences
- Tool orchestration now has explicit mechanical constraints per node.
- Runtime traces expose execution budgets for easier incident/debug review.
- Existing tool workflows require minor updates to include tool policies.
