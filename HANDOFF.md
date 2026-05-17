# ForgeOS Handoff

## Current State

ForgeOS is a greenfield Next.js App Router application for an autonomous startup organization runtime. The UI is no longer a single overloaded dashboard; it is split into focused management pages:

- `/forge/demo` - overview, health metrics, Executive Console, priority blockers, project completeness board
- `/forge/demo/org` - full organization map with local division/worker details
- `/forge/demo/operations` - searchable/groupable operations board with focused operation details
- `/forge/demo/workspace` - virtual file viewer and renderer
- `/forge/demo/assets` - Forge asset/artifact browser
- `/forge/demo/logs` - runtime event stream

The app currently uses an in-memory `RuntimeStore` seeded from `src/lib/mock/seed.ts`. It exposes API routes for runtime commands, snapshots, events, Executive Console messages, and virtual files. Zustand preserves newer client state across page navigation so mock runtime changes survive route changes.

## What Was Recently Fixed

- Main dashboard was split into multiple pages so operators do not have to scroll to inspect selected entities.
- Operation selections now deep-link from overview cards to `/forge/demo/operations?operation=<id>`.
- Operations page reads `operation` query params and focuses the matching card/detail pane.
- Operations page now supports:
  - search
  - group by status/division/worker/priority
  - status filtering
- Organization state projection was fixed. Running operations manually now updates:
  - operation status/progress
  - worker status
  - division status/progress
  - Forge phase
- Priority blockers on the overview page now explain:
  - why the operation is blocked
  - owning division/worker
  - downstream impact
  - next action

## Verification Status

Latest passing checks:

```bash
npm test
npm run build
npm run e2e
```

Current test counts:

- Unit/runtime: 9 tests passing
- E2E: 1 Playwright smoke test passing

Important workflow note: stop `npm run dev` before running `npm run build` or `npm run e2e`. Running Next dev and production build concurrently has repeatedly corrupted `.next` temporarily and caused missing chunk/manifest errors.

## Engine Transition: What Needs To Change Next

To move beyond dashboard simulation and start real engine work, the next session should focus on replacing the current in-memory mock runtime with a durable, command-driven runtime core.

### 1. Make RuntimeStore Durable

Current state lives only inside `src/lib/runtime/store.ts`. Replace or wrap it with a persistent store backed by Prisma:

- Append every mutation as `RuntimeEvent`.
- Persist normalized Forge state in Prisma tables.
- Persist `ForgeSnapshot` with `lastEventSequence`.
- Load active Forge state from DB instead of `createDemoSnapshot()` on every process start.
- Keep the same command API shape so the UI does not need to change.

Minimum target:

- `RuntimeStore.dispatch(command)` writes events and projections to DB.
- `RuntimeStore.getSnapshot()` reads the latest materialized snapshot.
- `RuntimeStore.getEvents(afterSequence)` reads durable events.

### 2. Separate Command Handling From Projection

`RuntimeStore` currently does everything: validation, mutation, projection, event append, and mock behavior. Split it into:

- `RuntimeCommandHandler` - validates and routes commands.
- `RuntimeProjector` - derives workers/divisions/Forge phase from operations.
- `EventStore` - appends ordered events and enforces idempotency.
- `SnapshotStore` - reads/writes current materialized state.
- `MockAgentRuntime` - emits operation execution events.

The goal is to make the dashboard consume the same snapshot/events while the engine implementation becomes swappable.

### 3. Enforce The Operation Graph

The current scheduler is light. Before real workers, implement real graph rules:

- Blocking dependencies must complete before an operation can become `ready`.
- `run_operation` should reject or block non-ready operations unless explicitly forced.
- Workers should only run one operation at a time.
- Failed operations should block downstream operations.
- Completion should unlock dependent operations.
- Add idempotency and command serialization around operation execution.

This is the first true Forge Runtime capability.

### 4. Implement Runtime Event Streaming

The plan calls for mock-to-real compatibility through streaming events. Current APIs are request/response snapshots. Add a runtime event stream:

- Prefer SSE at `GET /api/forge/current/events/stream`.
- Stream events by sequence.
- Let the client apply events or refetch snapshot after event batches.
- Keep polling fallback if SSE is unavailable.

This prepares for real Nemoclaw or other agent runtimes that produce intermediate progress/tool events.

### 5. Define WorkspaceAdapter v1

Files are virtual only right now, which is correct for safety. The next engine step is not writing to disk yet; it is formalizing the adapter:

- `listVirtualFiles(forgeId)`
- `readVirtualFile(fileId)`
- `writeVirtualFile(command/event)`
- optional future `syncToWorkspace(forgeId)`

All real workspace sync must stay behind `WorkspaceAdapter`; do not let workers directly read/write arbitrary paths.

### 6. Prepare Real Agent Adapter Contracts

The placeholder Nemoclaw adapter exists but is not wired into command execution. Next session should define the runtime boundary more concretely:

- `ProviderCapabilities`
- `RunHandle`
- `runOperation(input): AsyncIterable<RuntimeEventDraft>`
- `cancelOperation(operationId)`
- external refs: `externalAgentId`, `externalRunId`, `provider`, `providerMetadata`

Do not leak Nemoclaw-specific assumptions into the UI or core schema beyond nullable external refs.

## Recommended Next Implementation Slice

Build the engine in this order:

1. Add Prisma-backed `EventStore`, `SnapshotStore`, and seed/load path.
2. Move projection logic out of `RuntimeStore` into `RuntimeProjector`.
3. Make `run_operation` dependency-aware and add tests for blocked/ready/unlocked transitions.
4. Add SSE event stream or polling event reconciliation.
5. Wire `MockAgentRuntime` through the same `AgentRuntime` interface intended for real providers.

Success criteria for the next slice:

- Restarting the dev server does not reset Forge state unless `reset_demo_state` is called.
- Running an operation emits durable ordered events.
- Completing an operation unlocks eligible dependents.
- The UI remains unchanged except for consuming durable snapshots/events.
- `npm test`, `npm run build`, and `npm run e2e` pass.

## Known Caveats

- There is no git repository initialized in this workspace.
- `npm audit` reports moderate transitive vulnerabilities in dev/build tooling; suggested fixes require breaking upgrades, so they were not forced.
- `.next`, `.playwright-mcp`, screenshots, and console logs are ignored, but some local generated artifacts may still exist from verification runs.
- The current Prisma schema is Postgres-ready, but the app is not actually using Prisma for runtime state yet.
- The current Executive Console uses mock responses only.

## Useful Files

- `src/lib/runtime/store.ts` - current in-memory runtime store and projection logic
- `src/lib/runtime/types.ts` - runtime contracts and snapshot types
- `src/lib/runtime/scheduler.ts` - current dependency readiness helpers
- `src/lib/mock/seed.ts` - seeded Forge data
- `src/components/forge/forge-pages.tsx` - page-level UI and operations board logic
- `prisma/schema.prisma` - intended durable data model
- `tests/e2e/forgeos.spec.ts` - current smoke flow
