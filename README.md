# Personal Assistant

A personal **agent harness** in an [Nx](https://nx.dev) monorepo. One app, `apps/agent`, runs one process on one port (3333) that serves the HTTP API (with SSE) and the chat UI (`apps/web`, a Vite SPA). The runtime (`@agent/agent-core`) has two bindings:

- **Home**: chat, with optional web search.
- **Workspace**: a chat bound to one folder, with coding tools jailed to that folder.

The eval viewer (`apps/eval`) is a separate UI for measuring runs.

Read [AGENTS.md](./AGENTS.md) before changing code. It covers ownership, the lint-enforced module boundaries, where code goes, and the major files.

---

## Architecture

| Layer | Package / app | Responsibility |
| ----- | ------------- | -------------- |
| Shared types | `@agent/agent-models` | Events, ledger, threads, traces, modes (`HOME_MODE` / `WORKSPACE_MODE`). Imports nothing. |
| Runtime | `@agent/agent-core` | Loop, tools, context assembly, model calls, sub-agents. No HTTP, DOM or database. |
| Host state | `@agent/agent-service` | `createAgentService`: thread store, runs, memory, skills, checkpoints, traces. One per process. |
| Transport | `@agent/agent-http` | Express app: routes from the protocol table, access control, voice proxy, static UI. |
| Client | `@agent/agent-client` | The one HTTP client, used by the web UI and the eval runner. |
| App | `apps/agent` | The `agent` binary: `serve`, `web`, `run`, `eval`. |
| UI | `apps/web` | Chat UI. Talks to the API on its own origin. |
| Measurement | `@agent/agent-eval`, `apps/eval` | Read-only trace/ledger readers, metrics, trial runner, gate, and the viewer. |

### Request flow (chat)

```
apps/web composer
  → POST /api/agent/run                start the run (agent-http → agent-service)
  → assemble context                   ledger, memory, skills, workspace rules, compaction
  → RunManager.start → runLoop         agent-core
  → GET /api/agent/run/:runId/events   SSE AgentEvents
  → chat-store reducer                 apps/web
```

**Threads live on disk** under `AGENT_HOME`: a SQLite catalog plus one append-only `ledger.jsonl` per thread. The ledger is the durable history. Retry or edit **rewinds** it (truncates the later rows). SSE is the live path. Once a run handle expires (5 minutes after it settles) the client rebuilds from `GET /api/agent/threads/:id/ledger`.

**One active run per thread**, held in process memory. A message sent while a run is going is queued on the host (`sessions/<threadId>/queued.json`) and starts when the run settles. `POST /api/agent/run/:runId/cancel` stops a run.

**Checkpoints.** Before an Agent-posture run in a workspace, the host snapshots the files the run may touch. The UI shows what each run changed and can restore it.

### How to think about the harness

1. **The loop is a budget machine.** Each mode caps iterations, tool calls, prompt tokens and wall time (`packages/agent-core/src/lib/loop/limits.ts`). When the model loops, tune budgets and residency, not the system prompt.
2. **Context is a cache.** `assembleContext` keeps a stable prefix (system prompt, skills catalog, memory, rules) so the provider's prompt cache holds, and evicts by cost: old tool results become cards first, large bodies spill to blobs, older turns compact last. Anything evicted keeps a `sha256` the model can `recall`.
3. **Gates are code, not prompt text.** Memory writes, posture and the workspace path jail are deterministic checks. Same input, same verdict.
4. **The ledger is the truth.** `AgentEvent` is the live API. UI state that cannot be rebuilt from the ledger is a bug.
5. **Everything except the model is deterministic.** Compaction is extractive (no LLM call on the request path). Model calls outside the loop (thread titles) are maintenance work.

### Tools

Tools are registered in `@agent/agent-core` and filtered per run: the mode's `globalTools`, plus the user-toggleable `allowedTools` the composer sends (today only `web_search`). Profiles are in `packages/agent-models/src/lib/mode.ts`.

| Tool | Home | Workspace | Purpose |
| ---- | :--: | :-------: | ------- |
| `web_search` | toggle | toggle | Search: Ollama → Firecrawl → Tavily. Returns hit cards; the top 2 hits are prefetched into the source store. |
| `web_fetch` | ✓ | ✓ | Fetch a URL into the store and return a card (~2k teaser). Page through the stored text by `sha256` + `offset`. |
| `recall` | ✓ | ✓ | Read back a stored body by `sha256`: an evicted tool result, a sub-agent report, a compacted turn. |
| `load_skill` | ✓ | ✓ | Load a skill pack's instructions (see [Skills](#skills)). |
| `memory` | ✓ | ✓ | Read and change the user and project memory files. |
| `session_search` | ✓ | ✓ | Search messages in the user's other threads. |
| `read_thread` | ✓ | ✓ | Read another thread by id, a page of whole messages at a time (tool calls listed, tool results left out). |
| `plan`, `todo` | ✓ | ✓ | The thread's plan and to-do list. |
| `record_finding` | ✓ | ✓ | Record a cited finding that stays in context across turns. |
| `offer_choice` | ✓ | ✓ | Ask the user to pick between options. |
| `glob`, `grep`, `read_file` | | ✓ | Read the workspace (jailed to the folder). |
| `edit_file`, `run_terminal` | | ✓ | Change files and run commands in the folder. Commands get an allowlisted environment (no host secrets). Commands that reach off the machine or outside the folder ask first. |
| `diff` | | ✓ | `git diff HEAD` plus untracked files. |
| `delegate` | | ✓ (Agent posture) | Hand a side task to a sub-agent (`explore`, `review`, `advisor`, or a user agent). |

### Skills

Skills are [Agent Skills](https://agentskills.io) folders (`<name>/SKILL.md` with `name` and `description` frontmatter). They are read from, lowest to highest precedence:

1. Built-ins: `packages/agent-core/skills` (`patch-and-verify`, `home-research`, `plain-technical-english`).
2. `~/.agents/skills` (where `npx skills add <owner/repo> -g` installs).
3. `$AGENT_HOME/skills` (your own packs).
4. `<workspace>/.agents/skills`, for a bound workspace. It only adds new names and never replaces one from above.

The system prompt carries only the catalog (name + description). The model calls `load_skill` when a description matches its task, and gets the **whole** SKILL.md body plus a list of the pack's other files. `load_skill` with `file` reads one of them (jailed to the pack folder, paged past 20k chars). A loaded skill stays in the conversation; loading it again while it is still there returns a pointer instead of a second copy. A pack whose body is over 100,000 chars is listed as invalid; keep long detail in the pack's own files.

Invalid or shadowed packs are listed with a reason in the Skills panel and never loaded. Removing a pack moves it to `$AGENT_HOME/.trash/skills` (kept 30 days).

### Skills and threads in a message

Typing `/` in the composer names a skill; typing `@` attaches another thread (shown as a chip with a message icon). Both are **references**: the message carries the skill's name and the thread's id, and the model loads them with its tools: `load_skill` for the skill, `read_thread` for the thread, and only the pages it needs. Each load is an ordinary tool call in the ledger, shown as "Ran skill …" or "Read thread …". After compaction folds the turns that used them, the brief names those skills and threads so the model can load them again.

Optional packs in this repo live in `skills/` (for example `npx skills add <this-repo> --skill ai-writing-guidelines -g`).

### Writing rules

The harness writes to the model in controlled plain English, adapted from ASD-STE100: one instruction or fact per sentence, sentences of 25 words or fewer, active voice, the condition before the action, no hedges, and one term per concept (the glossary in `packages/agent-models/src/lib/style.ts`). The goal is precision: an instruction with one meaning keeps the model on the request. Code, commands, paths and quoted text keep their exact form.

- `checkStyle` checks text against the rules. `packages/agent-core/src/lib/prompts/plain-style.test.ts` runs it over every system prompt, tool description and guidance line, harness note and sub-agent prompt, so a new long or vague sentence fails the build.
- The workspace system prompt gives the model the same rules for its own text. The `plain-technical-english` skill holds the full set for answers, plans and reviews; pick it with `/`.
- Eval run metrics report `answerStyle` (sentence length, hedges, filler, a preamble before the result) and `drift` (repeats the harness answered, results read back, stall nudges), so a style change can be compared run against run.

### Context and budgets

- **Window.** Each thread budgets against 260K tokens by default, or the model's full window (composer toggle). Resolved in `packages/agent-service/src/lib/models/model-runtime.ts` from `packages/agent-models/src/lib/context.ts`.
- **Between runs.** History compacts at 65% of the input budget (or 100k tokens, whichever is lower), down to 25% (or 50k). Tool results from earlier turns stay in full, newest first, up to 40k tokens; older ones become cards.
- **Inside a run.** One pass on the whole prompt at the high mark (80% of the input budget) brings it down to the low mark (70%), cheapest loss first. Below the high mark nothing leaves, so the prompt prefix stays cacheable. See `packages/agent-core/src/lib/context/residency.ts`.
- **Per-run caps.** Home: 40 iterations, 80 tool calls, 400k prompt tokens, 15 minutes. Workspace: 500 iterations, 1,200 tool calls, 10M prompt tokens, 2 hours. One wrap-up nudge at 80%, a stop at 100%. Sub-agent spend counts against the parent.
- **Sub-agents.** One writer, many readers. Children get the profile's tools minus every write tool and `delegate`; no nesting; at most 4 in parallel; cancelled with the parent. Model roles: `AGENT_MODEL_FAST` (explore) and `AGENT_MODEL_STRONG` (review, advisor), both defaulting to the parent's model. User agents live in `$AGENT_HOME/agents/<name>.md`.
- **Traces.** Every run (children included) writes `<AGENT_HOME>/sessions/<threadId>/traces/<runId>.jsonl` with per-call usage and timing, context layers, evictions, compaction and budget events.

---

## Prerequisites

- **Node.js 24+** and **npm** (the workspace uses `package-lock.json`).
- **Ollama** for chat: an Ollama cloud API key (`OLLAMA_BASE_URL=https://ollama.com/v1`) or a local endpoint.
- **Web tools** work without extra keys (keyless Firecrawl and Tavily), but those tiers are shared and rate-limited. Set `FIRECRAWL_API_KEY` / `TAVILY_API_KEY` for regular use.
- **Voice (optional).** Dictation and read-aloud default to the browser's speech APIs. [Speaches](./docker/README.md) (Whisper + Kokoro, via Docker) is an optional local alternative.

## Environment

Copy the example and fill in secrets (never commit `.env`):

```bash
cp .env.example .env
```

| Variable | Purpose |
| -------- | ------- |
| `OLLAMA_BASE_URL` | Chat completions base URL (default: Ollama cloud). |
| `OLLAMA_API_KEY` | Chat (cloud), and the first web search/fetch layer. |
| `FIRECRAWL_API_KEY`, `TAVILY_API_KEY` | Optional: higher limits for the web layers. |
| `AGENT_HOME` | Where threads, memory, skills and traces live (default `~/.local/personal-assistant`). |
| `AGENT_MODEL_FAST`, `AGENT_MODEL_STRONG` | Optional sub-agent models. |
| `VOICE_STT_PROVIDER`, `VOICE_TTS_PROVIDER` | `browser` (default), `speaches` or `off`. |
| `SPEACHES_*`, `VOICE_STT_*`, `VOICE_TTS_*` | Speaches settings; see [docker/README.md](./docker/README.md). |

`agent` loads the repo's `.env.local` and `.env` itself and never overrides variables already set.

**Access.** The browser is admitted only as the server's own page (`Sec-Fetch-Site: same-origin` and the exact `Origin`). Local processes send the token from `$AGENT_HOME/api-token`. There is no CORS.

---

## Running

```bash
npm install

# Build, then serve the API + chat UI on one port and open the browser
npm start                     # → http://localhost:3333

# Development: Vite with hot reload on :4200, proxying /api to `agent serve` on :3333
npm run dev

# After a build
node apps/agent/dist/main.js serve [--home <dir>] [--port 3333] [--host localhost] [--no-ui]
node apps/agent/dist/main.js run "What is 2+2?" [--workspace <dir>] [--ask] [--mode home|workspace]
node apps/agent/dist/main.js eval --help
```

- **One server per home.** A running server records itself in `AGENT_HOME/server.json`. A second start on the same home prints the running server's URL and exits.
- **Graceful stop.** Ctrl+C refuses new runs, cancels running ones and saves them (up to 10 s). A second Ctrl+C exits at once.
- **`agent run`** is an isolated one-shot run in the current process: no agent home, memory or user skills. Its traces go to `apps/agent/traces/`.
- **Binding.** Keep `--host` on a loopback address. On any other host the browser is not admitted and every client needs the API token.

## Nx commands

```bash
npx nx run @agent/agent:build              # bundles apps/agent and embeds the web build as dist/ui
npx nx run-many -t typecheck
npx nx run-many -t lint                    # also enforces the module boundaries
npx nx affected -t typecheck build lint test
```

The apps reference built `.d.ts` files from `packages/agent-*/dist`. After changing `@agent/agent-models` or `@agent/agent-core` types, rebuild them (`npx nx run @agent/agent-core:build`) before typechecking dependants.

**Behaviour guards.** `packages/agent-http/src/lib/__contract__/` pins every HTTP route, the access rules, the static UI, SSE and one golden Workspace run. `apps/agent/src/local-run.contract.test.ts` pins the CLI run. `agent-core` `loop/__replay__/` pins event and trace order. A deliberate behaviour change re-records them (`vitest -u`) and the commit says why.

---

## Adding a tool

1. Define it in `@agent/agent-core` (`Tool`: OpenAI-style `definition`, `guidance`, `execute`).
2. Register it in `packages/agent-core/src/lib/tools/registry.ts`, or add a `ToolProvider` with `registerToolProvider`. Set `stage` (`read`, `network`, `exec`, `mutate`, …) so the loop schedules it correctly, and `outputCap` to bound its result.
3. Expose it through a mode: `globalTools` for always-on, `allowedTools` for user-toggleable.
4. Put per-tool rules in its `guidance`; they are injected into the system prompt. Edit `system-prompt.ts` only for cross-tool behaviour.
5. Tool lifecycle events (`tool.started` / `tool.completed` / `tool.failed`) render generically in the UI.

External HTTP for a tool belongs in core (for example `tools/web/router.ts`), not in routes.

## Web search and fetch

- **Fixed pipeline.** Search: Ollama → Firecrawl → Tavily. Fetch: the same scrape layers, then plain local HTTP. Failover happens inside the tool.
- **Store, then view.** The full page is stored (by `sha256`); the model sees a source card and pages through the stored text on demand.
- **Untrusted content.** Fetched text is wrapped as untrusted. Only URLs and shas from this run are allowed. Local HTTP re-checks private hosts after redirects. `run_terminal` refuses `curl`, `wget` and `Invoke-WebRequest`.

## Debugging

| Symptom | Check |
| ------- | ----- |
| Wrong tools offered | Request `allowedTools`, the mode's `globalTools`, `createToolRegistry`. |
| `web_search` fails | Keyless tiers rate-limited (429), or the `OLLAMA_API_KEY` layer. |
| Run stuck "running" | SSE disconnect (a seq gap refetches the ledger); every run ends with `run.settled`; the cancel route. |
| 409 on a new message | The thread already has a run; it is queued, or cancel it. |
| Title stays "New Chat" | The first message must go through `POST /run`; look for `[title]` in the server log. |
| `[skills] skipped …` at start-up | A pack that breaks the Agent Skills spec or is over the body limit; the reason is on the line and in the Skills panel. |
| Voice errors | Speaches health at `http://127.0.0.1:8000/health`; see [docker/README.md](./docker/README.md). |

## Repository layout

```
apps/
  agent/        the `agent` binary (serve, web, run, eval)
  web/          chat UI (Vite SPA, built into apps/agent)
  eval/         eval viewer (Next.js)
packages/
  agent-models/   shared types
  agent-core/     runtime: loop, tools, context, sub-agents
  agent-service/  host state and run logic
  agent-http/     HTTP adapter
  agent-client/   HTTP client
  agent-eval/     readers, metrics, trial runner, gate
evals/          task corpus (tasks/, baselines/)
skills/         optional skill packs to install
docker/         Speaches compose docs
```
