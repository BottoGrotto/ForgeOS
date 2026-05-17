# ForgeOS Handoff

## Current State

ForgeOS is a Next.js App Router application for deploying autonomous AI "forges" that coordinate agents, operations, artifacts, handoffs, workspace state, runtime events, and executive oversight for hackathon-style project builds.

The UI is split into focused management pages:

- `/forge/demo` - overview, health metrics, Executive Console, priority blockers, project completeness board
- `/forge/demo/org` - full organization map with local division/worker details
- `/forge/demo/operations` - searchable/groupable operations board with focused operation details
- `/forge/demo/workspace` - virtual file viewer and renderer
- `/forge/demo/assets` - Forge asset/artifact browser
- `/forge/demo/logs` - runtime event stream

The runtime is now command-driven and durable-ready:

- `RuntimeStore` is async and wraps persistence plus mock agent execution.
- Prisma-backed persistence exists for Forge state, normalized runtime tables, snapshots, events, and idempotency keys.
- In-memory persistence remains available for tests and local runs without `DATABASE_URL`.
- Runtime snapshots are loaded from persistence when available instead of always reseeding.
- Forge demo pages are dynamic so they read current runtime state per request.
- Client state uses Zustand and now listens to SSE runtime events, then refetches snapshots.

## Recently Completed

- Added Prisma-backed durable runtime persistence:
  - `PrismaRuntimePersistence`
  - `PrismaEventStore`
  - `PrismaSnapshotStore`
  - normalized Forge runtime tables
  - `ForgeSnapshot` JSON payloads
  - `RuntimeCommandLedger` idempotency table
- Added migrations:
  - initial runtime core migration
  - paused lifecycle enum migration
- Split projection logic into `src/lib/runtime/projector.ts`.
- Made `run_operation` strict:
  - rejects blocked/non-ready operations
  - rejects operation runs while paused/archived
  - completes ready operations deterministically through `MockRuntime`
  - unlocks eligible downstream operations
- Added lifecycle commands:
  - `pause_forge`
  - `resume_forge`
  - `shutdown_forge` as a backward-compatible safe-pause alias
- Fixed pause/resume regression:
  - pause records previous operation/worker/division states in the `runtime.paused` event payload
  - resume restores those states instead of recomputing all paused operations as blocked
  - after pause/resume, `op-qa` and `op-release` remain `planning`; only the original `op-tests` blocker remains blocked
- Added UI lifecycle controls:
  - Shutdown button while active
  - Resume button while paused
  - Reset remains available
- Added SSE event stream:
  - `GET /api/forge/current/events/stream`
  - supports `afterSequence`
  - sends missed events and heartbeat comments
  - client uses SSE as an invalidation signal and refetches snapshots
- Cleaned ESLint setup:
  - `next lint` replaced with `eslint .`
  - `eslint.config.mjs` added
  - current lint output is clean

## Verification Status

Latest passing checks:

```bash
npm run lint
npm test
npm run build
npm run e2e
```

Current test counts:

- Unit/API/runtime: 21 tests passing
- E2E: 1 Playwright smoke test passing

Important workflow note: stop `npm run dev` before running `npm run build` or `npm run e2e`. Running Next dev and production build concurrently has previously caused temporary `.next` chunk/manifest errors.

## Next Development Priorities

### 1. Commit And Push The Current Runtime Work

Before starting the next feature, commit the current lifecycle/SSE/handoff updates.

Recommended commands:

```bash
git add -A
git commit -m "feat: add forge lifecycle and event streaming"
git push -u origin main --force-with-lease
```

If `--force-with-lease` rejects with stale info, run:

```bash
git fetch origin main
git push -u origin main --force-with-lease
```

### 2. Connect GitHub Repositories To Forges

This is the next product capability requested by the user. A forge should be able to attach to a GitHub repository so agents can inspect project context and eventually produce branches/PRs.

Recommended v1 scope:

- Add a `ForgeRepository` or equivalent model/table.
- Store repo metadata, not secrets:
  - provider: `github`
  - owner
  - repo
  - default branch
  - selected working branch
  - installation/account reference for future auth
- Extend `ForgeSnapshot` so the UI can display connected repository state.
- Add API commands:
  - `connect_repository`
  - `disconnect_repository`
  - `refresh_repository_context`
- Add a UI section in the overview or workspace page to connect/display repo status.
- Keep real GitHub writes out of scope for v1; start read-only.
- Use GitHub token/app auth via environment variables or GitHub App installation, never hardcoded secrets.

Success criteria:

- A forge can persistently remember its connected GitHub repo.
- The UI shows connected repo metadata.
- Runtime events record connect/disconnect/refresh actions.
- Tests cover validation and persistence.

Recommended implementation order:

1. Add types and Prisma schema/migration for connected repositories.
2. Add seed data for a demo connected repo only if useful for UI development.
3. Add command validation and runtime events for connect/disconnect/refresh.
4. Add repository display/connect form in the UI.
5. Add tests before implementation:
   - command validation rejects malformed repo URLs/owners/names
   - connect persists repo metadata into snapshots
   - disconnect removes repo metadata
   - refresh emits a runtime event without writing files

### 3. Harden Runtime Command Serialization

The runtime has idempotency keys, but command execution is not yet protected by a proper per-forge lock.

Add:

- per-forge command serialization
- duplicate run protection per operation
- worker concurrency enforcement around persisted state
- tests for concurrent `run_operation` requests

### 4. WorkspaceAdapter v1

Virtual files are still the safe boundary. Formalize write operations before any real workspace sync.

Target interface:

- `listVirtualFiles(forgeId)`
- `readVirtualFile(fileId)`
- `writeVirtualFile(command/event)`
- optional future `syncToWorkspace(forgeId)`

All real filesystem or GitHub repo writes must stay behind a workspace/repository adapter. Agents should not directly read/write arbitrary paths.

### 5. Real Agent Adapter Contracts

`MockRuntime` is wired through the `AgentRuntime` interface. The placeholder Nemoclaw adapter still needs a concrete boundary before real execution.

Define:

- `RunHandle`
- `externalAgentId`
- `externalRunId`
- provider metadata
- streamed progress/tool events
- cancellation behavior
- retry/resume behavior

Avoid leaking Nemoclaw-specific assumptions into UI or core schema.

### 6. Improve Runtime Event Streaming

The SSE endpoint exists and the client refetches snapshots after streamed events. Next improvements:

- reconnect/backoff behavior
- last-event-id support
- browser-visible connection state
- integration tests for reconnect/missed events
- optional polling fallback if SSE fails

## Known Caveats

- Prisma is Postgres-oriented. Without `DATABASE_URL`, the app falls back to in-memory persistence.
- `npm audit` previously reported moderate transitive vulnerabilities in dev/build tooling; fixes may require breaking upgrades.
- The Executive Console still uses mock responses only.
- Real GitHub repo connection is not implemented yet.
- Real agent execution is not implemented yet.
- Safe pause/resume restores prior statuses from the latest `runtime.paused` event payload; if old persisted paused snapshots lack that payload, resume falls back to dependency readiness.
- `.next`, `.playwright-mcp`, screenshots, and console logs are ignored, but local generated artifacts can still exist from verification runs.

## Useful Files

- `src/lib/runtime/store.ts` - async command runtime facade
- `src/lib/runtime/prisma.ts` - Prisma-backed runtime persistence
- `src/lib/runtime/persistence.ts` - persistence interface and in-memory adapter
- `src/lib/runtime/projector.ts` - organizational state projection
- `src/lib/runtime/types.ts` - runtime contracts and snapshot types
- `src/lib/runtime/scheduler.ts` - dependency readiness helpers
- `src/lib/runtime/mock-runtime.ts` - deterministic mock agent runtime
- `src/lib/mock/seed.ts` - seeded Forge data
- `src/lib/store/forge-store.ts` - Zustand state plus SSE snapshot refresh
- `src/app/api/forge/current/events/stream/route.ts` - SSE event stream
- `src/components/forge/forge-pages.tsx` - page-level UI and lifecycle controls
- `prisma/schema.prisma` - durable runtime schema
- `tests/e2e/forgeos.spec.ts` - current smoke flow
