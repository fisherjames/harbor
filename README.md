# Harbor

Harbor is a TypeScript-native agent orchestration platform built around a harness-first runtime.

## What Is Implemented Now

This repository currently contains a working Phase 1 foundation:

- `@harbor/engine`: linear `plan -> execute -> verify -> fix` runtime with lint gating, retries, escalation, and memU hooks.
- `@harbor/harness`: workflow lint rules (`HAR001-004`) and prompt remediation injection (`## Harness Resolution Steps`).
- `@harbor/memu`: typed memU client with HTTP adapter, request signing, timeout, and retry+jitter.
- `@harbor/api`: tenancy-scoped tRPC router with deploy/run procedures.
- `@harbor/database`: Drizzle schema definitions and in-memory run persistence.
- `@harbor/observability`: OpenTelemetry trace wrapper for stage/finding/error events.
- `apps/worker`: Inngest worker scaffold with engine integration.
- `apps/web`: typed dashboard contract scaffold.

## Monorepo Layout

- `apps/web`
- `apps/worker`
- `packages/api`
- `packages/database`
- `packages/engine`
- `packages/harness`
- `packages/memu`
- `packages/observability`

## Local Development

1. Install dependencies:

```bash
pnpm install
```

2. Run quality checks:

```bash
pnpm check
```

3. Start local infra:

```bash
docker compose up -d
```

## Harness Linter Behavior

- `HAR001`: missing verifier node (critical)
- `HAR002`: unbounded tool permissions (critical)
- `HAR003`: missing timeout/retry budget (warning)
- `HAR004`: missing/invalid memU memory policy (critical)

Critical findings block runs/deploys. Warning/info findings are injected into prompts via `## Harness Resolution Steps`.

## Roadmap

- Phase 1: done as foundational runtime and contracts in this repo.
- Phase 2+: visual workflow builder, MCP registry, GitHub promotion flow, deeper eval harnesses, enterprise controls.
