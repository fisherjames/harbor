# @harbor/harness

## Purpose
Harness linting, prompt assembly, and remediation injection logic.

## Entrypoints
- `src/linter.ts`: lint orchestration.
- `src/rules/core-rules.ts`: HAR00x rule definitions.
- `src/prompt/assembler.ts`: prompt and resolution-step assembly.

## Commands
- `pnpm --filter @harbor/harness typecheck`
- `pnpm --filter @harbor/harness test`
