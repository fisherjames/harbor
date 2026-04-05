# @harbor/memu

## Purpose
memU adapter package for retrieval/writeback contracts and policy validation.

## Entrypoints
- `src/http/client.ts`: managed memU HTTP client.
- `src/in-memory/client.ts`: local in-memory adapter.
- `src/policy/validation.ts`: memory policy enforcement.

## Commands
- `pnpm --filter @harbor/memu typecheck`
- `pnpm --filter @harbor/memu test`
