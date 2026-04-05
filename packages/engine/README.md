# @harbor/engine

## Purpose
Workflow runtime engine and stage execution state machine.

## Entrypoints
- `src/runtime/runner.ts`: run coordinator and stage transitions.
- `src/contracts/runtime.ts`: runner dependency interfaces.
- `src/contracts/types.ts`: stable run and stage types.

## Commands
- `pnpm --filter @harbor/engine typecheck`
- `pnpm --filter @harbor/engine test`
