<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Run Nx as `npx nx …` or `nx …` (global CLI is fine). This workspace uses npm (`package-lock.json`). Do not use pnpm.
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->

# Personal Assistant

Nx monorepo for a personal agent harness: **one app** (`apps/agent`), one process and one port (3333) serving the API and the chat UI, built from libraries. One runtime (`agent-core`), two bindings: **Home** (chat, optional web) and **Workspace** (folder-bound coding tools). Setup, env, and the HTTP surface are in [README.md](./README.md).

`apps/web` is the chat product. `apps/eval` is the measurement viewer. They are not the same UI.

## Modules

| Project | Role | Use |
| ------- | ---- | --- |
| `packages/agent-models` | Shared shapes. Imports nothing. | Events, ledger, trace, threads, plans, modes (`HOME_MODE` / `WORKSPACE_MODE`), review artifact. One file per family under `src/lib/` (`event.ts`, `ledger.ts`, `trace.ts`, `run.ts`, `thread.ts`, `mode.ts`, `review.ts`, …). |
| `packages/agent-core` | Host-agnostic runtime. No HTTP, DOM, or database. | Loop, tools, context, model calls, sub-agents, System 1. Public surface is `src/index.ts`; the rest stays internal. |
| `packages/agent-service` | The one owner of host state (`type:service`). No HTTP. | `createAgentService({ config })` + `loadConfig(env)`: thread store, ledger, runs (`start-run`, `run-context`, compaction, titles), memory, skills, models/capacity, System 1, checkpoints, traces. One instance per process. |
| `packages/agent-http` | HTTP adapter (`type:adapter`). | `createApp(service, logger, { uiDir, browser, pickFolder })`: routes from `API_ROUTES`, access (same-origin browser or token), logging, errors, the voice (Speaches) proxy, the static chat UI. |
| `packages/agent-client` | The only HTTP client (`type:client`). | Route table methods/URLs, bearer token for processes. Used by web and the eval runner. |
| `apps/agent` | **The** deployable (`type:app`, bin `agent`). | `serve [--home --port --host --no-ui]`, `web`, `run` (the isolated in-process CLI run, unchanged), `eval` (forwards to the agent-eval CLI). Loads the root `.env` itself, runs from the repo root, owns the OS folder picker. The build embeds the web dist as `dist/ui`. |
| `apps/web` | Vite SPA chat (react-router). Imports `agent-models` and `agent-client` only, never `agent-core`. | Composer, thread view, sidebar, usage meters. Rebuilds from the ledger; SSE is the live path. Served by `apps/agent` on the same origin; produces assets, not a process. |
| `packages/agent-eval` | Read-only measurement. Imports `agent-models` only, never `agent-core`. | Readers, metrics, trial runner, gate. Trials talk to the HTTP API; they do not run a second loop. |
| `apps/eval` | Next.js viewer over `agent-eval`. Does not import `agent-core`. | Suite results, run traces, usage, thread/run **Review**. Not the chat UI. |
| `evals/` | Task corpus (not an Nx project). | `evals/tasks` (`regression/`, `matrix/`), `evals/baselines`. |

Lint (`@nx/enforce-module-boundaries` in `eslint.config.mjs`) matches this, using dependency tiers: `type:data` (agent-models) ← `type:engine` (agent-core, agent-eval) ← `type:service` ← `type:adapter` ← `type:app`; `type:client` and `type:ui` (web) see only data and client. `apps/eval` is `scope:eval` and may not import anything tagged `runtime:core` (agent-core). Every project has an explicit `lint` target, so `nx run-many -t lint` enforces these rules everywhere.

**Behaviour guards** (keep green): `packages/agent-http/src/lib/__contract__/` pins every HTTP route, the access rules, the static UI and SSE, plus one golden Workspace run with a scripted model (`__golden__/workspace-run.json`); `apps/agent/src/local-run.contract.test.ts` pins the isolated CLI run (`__golden__/local-run.json`); `agent-core` `loop/__replay__/` pins event and trace order. A deliberate behaviour change re-records them (`vitest -u`) and says why in the commit.

## Chat flow

```
apps/web composer (features/composer), same origin as the API (agent serve, :3333)
  → POST /api/agent/run          packages/agent-http/src/lib/runs/runs.routes.ts
  → start the run                packages/agent-service/src/lib/runs/start-run.ts
  → assemble run context         runs/run-context.ts (ledger, memory, skills, workspace, compaction)
  → RunManager.start             packages/agent-core/src/lib/run/run-manager.ts
  → runLoop                      packages/agent-core/src/lib/loop/loop.ts
  → GET /api/agent/run/:id/events  SSE AgentEvent
  → chat-store / use-agent-run   apps/web/src/features/conversation/
```

One active run per thread, in process memory. A live run's buffer replays every event to a reconnecting client, except the deltas of messages already completed (`assistant.completed` carries the text). After `RUN_HANDLE_TTL_MS` (5 minutes) the process keeps only the run's `run.settled`; a run it never ran (e.g. after a restart) is 404, and the client then rebuilds from `GET /api/agent/threads/:id/ledger`. A message sent while a run is going is queued on the host (`runs/queue.ts`, `sessions/<id>/queued.json`) and started once the run settles. One server per home: `apps/agent/src/server-file.ts` (`AGENT_HOME/server.json`). Retry/edit **rewinds** (truncates) the ledger. Title generation (`runs/thread-title.ts`) is maintenance, not on the request path.

**Home vs Workspace** is `packages/agent-models/src/lib/mode.ts`: allowed tools, global tools, iteration/token/wall limits. Home is chat; Workspace adds folder-jailed coding tools (`edit_file`, `run_terminal`, `delegate`, `diff`).

## Disk layout (`AGENT_HOME`)

Host-owned. Typical path: `.local/personal-assistant/`.

| Path | What |
| ---- | ---- |
| `catalog.db` | Thread index (SQLite). |
| `sessions/<threadId>/ledger.jsonl` | Active tape. Append-only until rewind. |
| `sessions/<threadId>/traces/<runId>.jsonl` | Per-run facts core recorded (schema `TRACE_SCHEMA_VERSION`). |
| `sessions/<threadId>/` blobs | Large bodies, recorded model-call payloads. |
| `reviews/<threadId>.json` | Stored thread Review (eval app). |

Eval reads these files. It does not re-derive what core already put in the trace.

## Runtime (major files)

**Loop** — `packages/agent-core/src/lib/loop/`

- `loop.ts` — iteration: model turn → tools → budget/limits → finish. Replay snapshots in `__replay__/` pin event/trace order.
- `limits.ts`, `run-budget.ts` — iteration, tool-call, token, and wall caps.
- `admission.ts` — whether a tool call runs, is answered instead, or ends the run (unknown tools, read storms, repeats, identical outcomes, report-only reserve, posture, research gate); returns a verdict `turn-tools.ts` applies.
- `progress-steering.ts` — stall / research-gate (absolute marks 750k / 1.25M).
- Loop passes take a declared view of `RunState` (`CardView`, `NotesView`, `ResidencyView`, `FinishView`, and the `run-state.ts` helpers), not the whole state; only the orchestrators (`loop.ts` `runLoopCore`, `turn-tools.ts`) hold all of it. Every run ends through `turn-finish.ts` `endRun`.
- `model-call.ts`, `call-record.ts` — streaming call; optional content-addressed recording of exactly what the model saw.
- `to-ledger-record.ts` — loop output → ledger row.

**Context** — `packages/agent-core/src/lib/context/`

- `assemble-context.ts` — builds the prompt. Old tool results stub first, then attachments; large bodies spill to blobs; tape compact last.
- `residency.ts` — in-run residency: one pass at the high mark on the whole prompt (`inRunMarks` in `agent-models/src/lib/context.ts`), removing by value down to the low mark (`(evicted)` cards with a sha), then the extractive recap; nothing leaves below the mark. The boundary that runs it is `loop/residency-pass.ts`. Compaction is not an LLM call.
- Host-side between-run compact: `packages/agent-service/src/lib/runs/compaction.ts`. Window size: `packages/agent-service/src/lib/models/model-runtime.ts` + `agent-models/src/lib/context.ts`.

**Tools** — `packages/agent-core/src/lib/tools/`

- `registry.ts` — per-run allow list (composer toggles ∪ mode `globalTools`).
- `web/` — `web_search` (opt-in), `web_fetch` (always).
- `workspace/` — path jail, `read_file` / `edit_file` / `run_terminal`.
- `memory.ts`, `plan.ts`, `offer-choice.ts`, `recall.ts`, `skills.ts`.
- Memory / posture / path jail are deterministic gates (`memory/gate.ts`), not prompt text.

**Model and System 1**

- `model/client.ts`, `model/stream.ts` — Ollama (cloud or local).
- `system1/port.ts` — classifier: state + questions → scores (`ask` / `report`). Not a writer. Host wires it in `packages/agent-service/src/lib/runs/system1-runtime.ts`.

**Sub-agents** — `packages/agent-core/src/lib/subagent/` (`delegate.ts`, `profiles.ts`, `runner.ts`). Host: `packages/agent-service/src/lib/runs/subagent-host.ts`. Profiles: explore, review, advisor, user agents under `$AGENT_HOME/agents/`. Children cannot nest; cancelled with the parent.

**Events** — `packages/agent-models/src/lib/event.ts` is the live API shape. Core emits (`events/emitter.ts`, `events/trace.ts`); API streams; web reduces; eval reads the on-disk trace/ledger.

## Hosts (major files)

**App** — `apps/agent/src/`

- `main.ts` — the `agent` commands; `load-env.ts` is imported first (root `.env.local`, `.env`).
- `serve.ts` — `createAgentService` + `createApp` + `listen`, then start-up work (harness version, System 1 warm-up, role-model check).
- `run.ts`, `local-run.ts` — the isolated CLI run (no home, memory, user skills or System 1; traces to `apps/agent/traces/`).
- `pick-folder.ts` — the native folder dialog (an OS port passed to `createApp`).

**Service** — `packages/agent-service/src/lib/`

- `config.ts` — `loadConfig`: the host's env parsed once into a typed `AgentConfig` (nothing downstream reads raw env); `service.ts` — `createAgentService`; `errors.ts` — `ServiceError`.
- `threads/thread-store.ts` — catalog + ledger + plans on disk; `threads/workspace.ts`, `checkpoints.ts`.
- `runs/start-run.ts`, `queue.ts` (the queued message), `run-context.ts`, `compaction.ts`, `thread-title.ts`, `subagent-host.ts`, `system1-runtime.ts`.
- `platform/atomic-write.ts` (every replace-a-file write), `platform/trace-sink.ts`, `platform/harness-version.ts`; `memory/`, `skills/`, `models/`, `voice/`.

**HTTP** — `packages/agent-http/src/lib/`

- `app.ts` — `createApp`: Host guard, `/api` access guard, routers from `API_ROUTES`, voice, static UI.
- `platform/access.ts` (same-origin browser via Fetch Metadata + exact Origin, or the api-token), `static-ui.ts`, `logger.ts`, `http-errors.ts`.
- `<topic>/<topic>.routes.ts` — threads (CRUD, ledger, workspace pick), runs (start, cancel, choice, SSE), memory, skills, models; `voice/voice.routes.ts`.

**Web** — `apps/web/src/`

- `main.tsx` — router (`/`, `/chat/:threadId`); `app/home-page.tsx`, `app/chat-page.tsx`; `vite.config.mts` (dev proxy `/api` → :3333).
- `features/conversation/` — `use-agent-run`, `chat-store`, message list, cards (`thread-session` is the SSE/ledger client).
- `features/composer/` — input, model/thinking/web/skills/voice.
- `features/threads/` — sidebar, spaces, workspace picker.
- `features/usage/` — context and account meters.
- `api/` — HTTP clients, one per topic (over `agent-client`; `API_BASE` is `''`, same origin).

## Eval flow

Trials: `packages/agent-eval/src/runner/runner.ts` grades a task by calling the **same HTTP API** (`runner/api-client.ts`), then reading the thread’s ledger/traces. Budget stop cancels a trial at 2× its token budget. Gate/baseline: `gate/`. CLI entry: `cli/main.ts`.

Viewer (`apps/eval`): server pages over those readers — `/results`, `/results/[id]`, `/runs/[id]`, `/threads/[id]`, `/usage`. Home path: `apps/eval/src/lib/home.ts`.

**Review** (thread/run performance, not the `delegate(review)` sub-agent):

- Digest: `packages/agent-eval/src/analyze/review.ts` (`analyzeThread`, `buildReviewInput`) — metrics + ≤5 `run_finish` excerpts, no whole-trace dump.
- Types: `packages/agent-models/src/lib/review.ts` (`ReviewArtifact`, `reviewFingerprint`).
- UI: `apps/eval/src/review/` (verdict, CTA, store, narrative). Destination is `/threads/[id]/review`. Thread and run pages link/run a review; they are not the review document. Unchanged fingerprint serves `reviews/<threadId>.json`; narrative is one bounded JSON call over the digest.
