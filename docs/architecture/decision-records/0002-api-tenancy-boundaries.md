# ADR 0002: Tenancy-Scoped API Contracts

## Status
Accepted

## Context
Harbor must be multi-tenant from MVP with strict workspace boundaries.

## Decision
- All API procedures require `tenantId`, `workspaceId`, and `actorId` in context.
- Mutations reject requests missing tenancy context.
- Workflow run requests are built from tenancy-scoped context and never from client-only IDs.

## Consequences
- Reduced risk of cross-tenant access.
- Slightly more ceremony in API context setup and tests.
