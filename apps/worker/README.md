# @harbor/worker

## Purpose
Durable workflow execution workers using Inngest, including run isolation setup and teardown.

## Entrypoints
- `src/inngest.ts`: event handlers and execution triggers.
- `src/run-isolation.ts`: worktree-bound isolation lifecycle.
- `src/index.ts`: worker bootstrap.

## Commands
- `pnpm --filter @harbor/worker typecheck`
- `pnpm --filter @harbor/worker test`
