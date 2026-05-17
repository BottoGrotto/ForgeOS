# ForgeOS

ForgeOS is an operating system for autonomous AI organizations. The MVP is a mock-first command center for hackathon startup Forges, with strict runtime contracts for future Nemoclaw-backed worker execution.

## Architecture

- Next.js App Router, TypeScript, Tailwind CSS, Zustand, Prisma.
- Server-authoritative runtime state via normalized records plus append-only events.
- `RuntimeStore` is the only mutation boundary for mock execution commands.
- `AgentRuntime`, `LLMProvider`, `NemoclawAdapter`, and `WorkspaceAdapter` define the mock-to-real swap surface.
- Project files are virtual in v1 and never read from or written to the real workspace.

## Organization Model

The seeded demo Forge includes Executive AI plus Strategy, Operations, Engineering, Presentation, QA, and Release divisions. Workers expose redacted context manifests instead of raw provider internals.

## Local Setup

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:3000/forge/demo`.

## Verification

```bash
npm test
npm run build
```

## Roadmap

Phase 1 ships the rich dashboard, mock runtime, virtual workspace, artifacts, handoffs, events, and Executive Console. Future phases add real Nemoclaw execution, dynamic worker spawning, persistent memory, real workspace sync through `WorkspaceAdapter`, and multi-forge orchestration.
