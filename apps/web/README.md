# @harbor/web

## Purpose
UI and server surfaces for workflow design, deployment, run monitoring, and memory exploration.

## Entrypoints
- `src/server/dependencies.ts`: app dependency graph and runtime wiring.
- `app/workflows/[workflowId]/builder`: workflow builder routes/actions.
- `app/runs/[runId]/page.tsx`: run timeline and diagnostics view.

## Commands
- `pnpm --filter @harbor/web typecheck`
- `pnpm --filter @harbor/web test`
