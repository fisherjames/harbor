# @harbor/worker

## Purpose
Durable workflow execution workers using Inngest, including run isolation lifecycle, scheduled nightly adversarial scans, and scheduled stuck-run recovery scans.

## Entrypoints
- `src/inngest.ts`: event handlers and execution triggers.
- `src/run-isolation.ts`: worktree-bound isolation lifecycle.
- `src/index.ts`: worker bootstrap.

## Commands
- `pnpm --filter @harbor/worker typecheck`
- `pnpm --filter @harbor/worker test`
- `pnpm --filter @harbor/worker build`
- `pnpm --filter @harbor/worker start:inngest`
