# ForgeOS

ForgeOS is an operating system for autonomous AI organizations. It provides a multi-Forge command center where an operator can create isolated AI teams, ask the Executive AI to plan work, run operations through provider-backed workers, inspect lifecycle logs, and review generated workspace files, artifacts, and usage.

## Architecture

- Next.js App Router, TypeScript, Tailwind CSS, Zustand, Prisma, and PostgreSQL.
- Server-authoritative Forge runtime state with append-only events and persisted run records.
- `RuntimeStore` is the mutation boundary for Forge commands, scheduling, execution, and provider output projection.
- `AgentRuntime` providers expose a common contract for `mock`, `codex`, `openclaw`, and `nemoclaw`.
- Real providers receive only the compact `providerPrompt`; full internal context, accounting, prompts, schemas, provider payloads, and credentials stay inside ForgeOS.
- Generated work is projected into Forge-owned virtual files, artifacts, handoffs, blockers, and events. Repository writes, branches, commits, and PRs are intentionally out of scope.

## Routes

- `/forges` - create/select Forges, delete selected Forges, clear local dev data.
- `/forge/[forgeSlug]` - Executive AI overview, chat, project health, needs-attention, and team health.
- `/forge/[forgeSlug]/org` - organization map with divisions, default workers, and spawned workers.
- `/forge/[forgeSlug]/operations` - operation board, run controls, lifecycle timeline, usage, and rate-limit summaries.
- `/forge/[forgeSlug]/workspace` - virtual file viewer, repository sync controls, long-prompt workspace files, and local launcher check/preview actions.
- `/forge/[forgeSlug]/assets` - artifact browser.
- `/forge/[forgeSlug]/logs` - runtime event stream.
- `/usage` - overall usage, per-Forge usage, provider totals, recent runs, and optional OpenAI organization costs.

## Runtime Model

Each Forge has isolated snapshot state, events, idempotency keys, run records, and optional durable run claims. A fresh Forge starts with the default divisions and workers but no operations, runs, messages, files, or artifacts. Demo state is loaded only through explicit reset/demo commands, not by ordinary Forge creation.

`run_operation` creates an `AgentRun`, emits `run.queued` and `run.started`, executes the selected provider, and projects completed/failed/canceled state back into the Forge. Manual operation runs stay scoped to the selected operation. Team-wide execution is driven by scheduler/autofill commands and respects global/provider concurrency caps.

The Executive AI can create and revise operation proposals using recent chat history. It receives explicit delegation guidance so Strategy, Engineering, Operations, QA, Release, and default workers get appropriately scoped tasks. Default workers remain idle until spawned or assigned; only workers that actually run work move into running/completed/failed states.

## Local Setup

Install dependencies:

```bash
npm install
```

Create `.env.local` or `.env` from `.env.example`, then configure at least operator auth and persistence:

```bash
FORGEOS_OPERATOR_PASSWORD=change-me
FORGEOS_SESSION_SECRET=change-me-to-a-long-random-secret
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=public
```

Apply database migrations:

```bash
npx prisma migrate deploy
npx prisma generate
```

Start the app:

```bash
npm run dev
```

Open `http://localhost:3000/forges`.

Without `DATABASE_URL`, ForgeOS falls back to `.forgeos/runtime-store.json`. That is useful for local UI work, but PostgreSQL is recommended for real multi-agent testing.

## Provider Configuration

The default provider is mock:

```bash
FORGEOS_AGENT_PROVIDER=mock
```

To run real Codex/OpenAI API-backed workers:

```bash
FORGEOS_AGENT_PROVIDER=codex
FORGEOS_AGENT_MAX_CONCURRENT_RUNS=4
FORGEOS_CODEX_MAX_CONCURRENT_RUNS=4
FORGEOS_CODEX_API_KEY=...
FORGEOS_CODEX_MODEL=gpt-5.4-mini
FORGEOS_CODEX_WORKER_MODEL=gpt-5.4-mini
FORGEOS_CODEX_DIVISION_HEAD_MODEL=gpt-5.4-mini
FORGEOS_CODEX_REASONING_MODEL=gpt-5.4-mini
FORGEOS_EXECUTIVE_MODEL=gpt-5.4-mini
FORGEOS_ALLOW_EXPENSIVE_MODELS=0
FORGEOS_EXECUTIVE_AUTOPILOT=1
FORGEOS_CODEX_MAX_RETRIES=1
FORGEOS_CODEX_MAX_RETRY_WAIT_MS=5000
FORGEOS_CODEX_WORKER_REQUEST_TIMEOUT_MS=30000
FORGEOS_CODEX_REASONING_REQUEST_TIMEOUT_MS=60000
```

`FORGEOS_AGENT_MAX_CONCURRENT_RUNS` is the global in-process run cap. `FORGEOS_CODEX_MAX_CONCURRENT_RUNS` is the Codex/OpenAI provider cap. Setting both to `4` means ForgeOS may keep up to four provider calls in flight at once, assuming there are ready operations and available workers.

Worker runs use `FORGEOS_CODEX_WORKER_MODEL`. Executive AI uses `FORGEOS_EXECUTIVE_MODEL`. Division-head/director and reasoning-heavy worker runs use `FORGEOS_CODEX_DIVISION_HEAD_MODEL` and `FORGEOS_CODEX_REASONING_MODEL`. Known expensive OpenAI model names are downgraded to `gpt-5.4-mini` unless `FORGEOS_ALLOW_EXPENSIVE_MODELS=1` is set.

`FORGEOS_AGENT_PROVIDER` should be `codex` for the OpenAI Responses API Codex provider. It is not `openai`; OpenAI is the underlying API vendor, while `codex` is the ForgeOS provider name.

OpenClaw is disabled unless selected:

```bash
FORGEOS_AGENT_PROVIDER=openclaw
FORGEOS_OPENCLAW_ENDPOINT=...
FORGEOS_OPENCLAW_API_KEY=...
FORGEOS_OPENCLAW_MAX_CONCURRENT_RUNS=1
```

`run_operation` can also select a provider per run with `agentProvider: "mock" | "openclaw" | "codex" | "nemoclaw"`.

## Usage And Billing

The `/usage` page always displays usage recorded from `AgentRun.usage`, including input tokens, output tokens, cached input tokens, request count, estimated cost, provider totals, and per-Forge totals.

Optional OpenAI organization cost data requires an admin key with the correct organization permissions:

```bash
FORGEOS_OPENAI_ADMIN_KEY=...
```

If the OpenAI Costs API returns `403`, the app can still show local run usage, but authoritative organization spend is unavailable until the key/account has access.

## GitHub Sync

GitHub OAuth is read-only and syncs bounded text files into Forge virtual workspace state.

```bash
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
FORGEOS_TOKEN_SECRET=...
FORGEOS_APP_URL=http://localhost:3000
# NEXT_PUBLIC_APP_URL=http://localhost:3000 also works for local callback URL resolution.
```

For local OAuth testing, configure the GitHub OAuth callback URL as:

```text
http://localhost:3000/api/github/oauth/callback
```

Tokens are encrypted server-side and are not included in snapshots, events, provider prompts, or API payloads.

## Workspace And Launcher

Long Executive prompts can be saved as virtual workspace files and referenced by command payload instead of being sent inline. Generated project files can be materialized into an isolated launcher workspace for local checks and previews through `run_project_check`, `start_project_preview`, and `stop_project_preview`; these commands operate on Forge virtual files and do not write back to the connected repository.

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
npm run e2e
```

When using a real `.env`, the full test suite may pick up real DB or Codex settings. For deterministic test runs, use explicit test env values or run targeted suites for the area being changed.

## Current Roadmap

The current priority is real small-scale multi-agent execution with failure isolation:

- Keep unrelated operations running when one provider call fails.
- Classify provider/API failures into rate-limit, network, schema, provider-output, context, dependency, and unknown categories.
- Add bounded self-repair/retry/replan behavior for recoverable failures.
- Persist partial valid artifacts/files even when some provider output is invalid.
- Surface sanitized failure diagnostics and recovery status in operation summaries.

Keep durable setup, environment, runtime, provider, and verification guidance in this README. Transient session handoffs and planning notes should stay outside tracked source unless they are promoted into stable project documentation.
