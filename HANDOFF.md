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

### 2. GitHub Repository Adapter v1

Metadata-only repository connection now exists: a Forge can store GitHub owner/repo/default branch/working branch metadata, show it on the Workspace page, and emit connect/disconnect/refresh runtime events.

The next GitHub milestone is a read-only adapter, not writes:

- Add a `GitHubRepositoryAdapter` behind a repository/workspace boundary.
- Authenticate through environment variables or GitHub App installation references only.
- Fetch safe read-only context:
  - repository existence
  - default branch
  - branch list
  - README/tree metadata
  - recent refs if useful
- Keep API responses, snapshots, and runtime events free of secrets.
- Do not create branches, commits, pull requests, or repository files in this phase.

Future write actions must be explicit, auditable runtime commands such as `create_working_branch` or `open_pull_request`, require operator approval, and route through the repository adapter rather than direct UI/runtime side effects.

### 3. Multi-Forge Instance Support

The database schema is mostly multi-Forge-shaped because normalized runtime tables are keyed by `forgeId` and Forge has a unique `slug`, but the app is not yet ready to deploy multiple independent Forge organizations.

Remaining work:

- Replace hard-coded `/forge/demo` routes and nav with dynamic Forge slug routes.
- Replace `/api/forge/current/*` APIs with Forge-scoped APIs.
- Make `RuntimeStore` load, dispatch, persist, and stream per `forgeId` or slug instead of a singleton current snapshot.
- Add Forge create/list/archive/reset flows.
- Add per-Forge command serialization and idempotency.
- Add tests proving one Forge's commands/events/repository state cannot affect another Forge.

### 4. Harden Runtime Command Serialization

The runtime has idempotency keys, but command execution is not yet protected by a proper per-forge lock.

Add:

- per-forge command serialization
- duplicate run protection per operation
- worker concurrency enforcement around persisted state
- tests for concurrent `run_operation` requests

### 5. WorkspaceAdapter v1

Virtual files are still the safe boundary. Formalize write operations before any real workspace sync.

Target interface:

- `listVirtualFiles(forgeId)`
- `readVirtualFile(fileId)`
- `writeVirtualFile(command/event)`
- optional future `syncToWorkspace(forgeId)`

All real filesystem or GitHub repo writes must stay behind a workspace/repository adapter. Agents should not directly read/write arbitrary paths.

### 6. Real Agent Adapter Contracts

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

### 7. Improve Runtime Event Streaming

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
- GitHub repository connection is metadata-only; real GitHub API reads/writes are not implemented yet.
- Multiple Forge instances are modeled in the database but not fully supported by routes, APIs, or the singleton runtime store yet.
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
