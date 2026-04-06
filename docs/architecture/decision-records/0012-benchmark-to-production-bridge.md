# ADR 0012: Benchmark-to-Production Bridge

## Status
Accepted - April 6, 2026

## Context
Harbor previously exposed eval, promotion, adversarial, and shadow gates as separate fields, but lacked a single typed bridge contract representing the end-to-end path from benchmark quality to production progression decisions.

## Decision
Introduce a `BenchmarkToProductionBridge` contract in `@harbor/api` and populate it in deploy, publish, and promotion PR flows.  
The bridge includes:
- unified gate step statuses (`lint`, `eval`, `promotion`, `adversarial`, `shadow`)
- blocked reasons
- explicit `nextAction`
- rollout mode and progression target (`deploy`, `publish`, `promotion`)

## Consequences
- Deploy/publish/promotion all share one machine-readable bridge path.
- Existing gate fields remain for backward compatibility.
- Future automation can consume a single bridge object instead of stitching separate tool outputs.
