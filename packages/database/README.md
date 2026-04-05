# @harbor/database

## Purpose
Persistence abstractions and adapters for workflow versions, runs, traces, and artifacts.

## Entrypoints
- `src/repositories/run-store.ts`: run persistence contracts.
- `src/repositories/in-memory-run-persistence.ts`: local adapter.
- `src/repositories/postgres-run-persistence.ts`: Postgres adapter.

## Commands
- `pnpm --filter @harbor/database typecheck`
- `pnpm --filter @harbor/database test`
