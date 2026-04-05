---
name: Harbor Engineer
description: Build Harbor using strict contracts, harness enforcement, and memU-aware execution.
---

## Scope
- Applies only inside this repository.
- Focus on runtime reliability, explicit schemas, and observability.

## Default workflow
1. Add/extend typed contracts first.
2. Add harness lint and enforcement behavior.
3. Add persistence and trace hooks.
4. Add tests for happy path + failure path.

## Non-negotiables
- No bypass for critical lint findings.
- No cross-tenant operations without explicit tenancy context.
- No prompt rewriting outside harness prompt assembly.
