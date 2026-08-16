# dsh-01 — DeepSeek Harness: Architecture Overview (Deep-Dive)

Source repo (local, read-only): `docs/references/deepseek-harness` (clone of github.com/deepseek-ai/deepseek-harness, MIT, developer preview).
All paths below are relative to that repo root. Companion reports: dsh-02 (philosophy/decision record), dsh-03 (implementation patterns), dsh-04 (paper: Cordis formalism), dsh-05 (Orange Book field data), dsh-06 (trade-offs/lessons).

---

## 1. What dsh is

DeepSeek Harness (`dsh`) is an open-source agent harness from DeepSeek AI. The defining architectural bet is stated in one line of `README.md`: "It uses an architecture where **everything is a plugin**, and is powered by Cordis". The product ships as a Web UI (`npx @deepseek-ai/dsh web`, serving `http://127.0.0.1:3080`) and a headless one-shot runner, both of which are *thin compositions over the same plugin tree* — not separate applications (`docs/user/guide/index.md`, `packages/bundle/headless/README.md`).

Scale of the codebase (measured locally):

- `packages/` contains **54 top-level groups and 219 packages** (`ls packages/ | wc -l`; `find packages -maxdepth 2 -mindepth 2 -type d | wc -l`), all published under the `@deepseek-ai/dsh-*` npm scope (`packages/README.md`).
- Largest groups by package count: `client/` 40, `session/` 13, `subagent/` 11, `shell/` 9, `host/` 8, `core/` 8, `util/` 7, `fs/` 7 (measured via `ls` per group).
- Documentation is a first-class artifact: 120+ English docs including **44 subsystem pages** (`docs/subsystems/`), 4 postmortems (`docs/postmortem/0001..0004`), generated catalogs (`docs/module-graph.md` 1638 lines, `docs/capability-seams.md`, `docs/event-producer-consumer.md`, `docs/tool-catalog.md`, `docs/persistence-catalog.md`, `docs/config-catalog.md`), and 688 Agent Notes (decision records) under `.agents/notes/` in implemented/proposed/rejected/archived states.

---

## 2. The plugin substrate: Cordis in five ideas

Everything in dsh is built on Cordis, vendored under the `@deepseek-ai` scope (see §8). The primer (`docs/cordis-primer.md`) compresses the model:

1. **A plugin is an object implementing `Service`** — a function with optional `inject` and `apply(ctx)`, or a `Service` subclass whose lifecycle Cordis mounts into the current context.
2. **A context is a repository of services.** A service claims a stable `ctx.<key>` (`ctx.tools`, `ctx.llm`, `ctx.sessions`); other plugins find services by key, never by importing a concrete implementation.
3. **Dependencies are declared via `inject`**, so load order is expressed as service requirements rather than manual boot sequencing.
4. **Typed events** dispatched as one of four modes, where *the mode is part of the event's public contract* (documented with an `@mode` tag, checked by the generated catalog):
   - `emit` — fire-and-forget, registration order, no return.
   - `waterfall` — around-middleware; listener gets `(...args, next)`, must call `next()` to delegate, may short-circuit by returning without `next()`.
   - `parallel` — all listeners run concurrently, awaited.
   - `serial` — in registration order, awaited, with return value.
5. **Registrations are reversible effects.** Prompt sections, tool schemas, adapters, providers, listeners are installed through `ctx.effect()` / `ctx.on()`, so reload and teardown unwind predictably. This is the formal "temporal composability" property the Cordis paper proves (dsh-04).

The architecture doc draws the product consequence: "There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads" (`docs/architecture.md`, §Cordis).

---

## 3. Boot composition: profiles → bundles → patch layers

A running dsh is **a plugin tree composed at boot from ordered layers** (`docs/architecture.md`, §Profiles and bundles):

- A **profile** is a named composition stored under the Harness home: `$DSH_HOME/profiles/<name>` (default home `~/.dsh` via `resolveDshHome`). It holds a `package.json` with out-of-tree plugin `dependencies` plus the manifest `dsh.profile.bundles` (ordered bundle list), and the user's `cordis.patch.yml`. `web` and `headless` ship as `PROFILE_TEMPLATES` that auto-initialize on first use (`packages/boot/app-boot/README.md`, §Profiles).
- A **bundle** is a distribution format for Cordis config rows + the code they mount: it declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` in its `package.json`. `dsh-base` is the first layer of *every* profile.

Layer application order onto an empty entry list (`docs/architecture.md`): each bundle in the profile's listed order → the profile's `cordis.patch.yml` → the home-level `cordis.patch.yml` → any `--patch` overlay. **A patch targets a row by id and replaces its whole config** — there is deliberately no deep-merge layer (`packages/bundle/base/README.md`, Known Limitations: "A patch replaces whole row configs — profile overrides must restate every field a row keeps").

Boot mechanics live in `packages/boot/app-boot/README.md` (export table):

- `boot(binName, configPath, patches?, prepare?, bareModuleBaseUrl?)` creates the root context, exposes `dshHomePath(...)` to Loader `!!js` config expressions, installs the Loader, mounts and awaits the include tree, then `assertEntriesLoaded` / `assertEntriesActivated` audit that every enabled entry actually has a fiber and activated — failures name every unresolved plugin and include original stacks; a partial context is disposed before the labelled rejection.
- `composeEntries` applies patch layers "through the include's own `applyEntryPatches`, so composition, flag derivation, and config dumps cannot drift from what boots".
- `renderConfigDump` powers `dsh --profile web --dump-config`, which prints the exact tree your machine boots — any printed row can be replaced by a user patch.
- `watchUserPatches` keeps `cordis.patch.yml` **live through HMR**: each add/change/removal transactionally recomposes the full patch list; a rejected read/parse/Loader candidate leaves the last good tree running and broadcasts `hmr/config-update-failed`. An empty or comments-only patch file *throws* (it parses to nothing, not to a list); `[]` is the explicit "disable this layer".
- `.env` layering (home-level): invoking-directory file outranks the Harness-home file, both below the inherited environment; bootstrap-only file variables are rejected case-insensitively; managed credentials live separately in `.credentials.yaml`.

Concrete layer contents (from `apps/cli/composition.md` and bundle READMEs):

- **`dsh-base`** inserts: timer, hmr, `dsh-llm`, `dsh-session`, typert registry/loader/gateway, session-title (+LLM provider), user-questions, `dsh-agent`, agent-default-model, jobs-local, llm-retry, settings-file, credentials-local, `dsh-llm-pi-ai`, session-persistence-jsonl, attachment-local, session-query-sqlite, session-projection, session-telemetry-otel, subprocess-local, sandbox-local, sandbox-policy, and the tool/shell/terminal/fs families. It also does **platform gating inside one patch file**: `bash-sandbox`/`tool-bash` rows carry `disabled: !!js process.platform === 'win32'` while the pwsh twins mount win32-only with the inverted expression — "one shared patch file, exactly one shell stack per host" (`packages/bundle/base/README.md`).
- **`dsh-web-app`** rides over base: sets the coding persona, inserts Web host rows (webserver, API gateway, workspace, projection cache, storage), the browser plugin roster, the always-on client-plugin reload chain, and the `web-runtime` glue plugin (`printUrl`, `surfaceContext`, `trustedHosts`). It owns the app command line: parses `--host`, `--port`, repeatable `--trusted-host`; **rejects `--host 0.0.0.0` before publishing the service**; and nothing binds a port before argument resolution, so `dsh --profile web --help` starts no server (`packages/bundle/web-app/README.md`).
- **`dsh-headless`** rides directly over base: coding persona, tool mode, HMR disabled, Code Mode worker, and the `headless-runner` plugin. After the Loader settles it reads `ctx.agentDefaultModel`, creates **one fresh persisted Agent**, submits the task as an ordinary user message, waits for quiescence, flushes the Session, folds the owned durable event interval, writes the last non-empty assistant text to stdout, and exits 0 only if the final `turn/end` completed (`packages/bundle/headless/README.md`). No host, no HTTP server, no listening port.

---

## 4. The core spine (product packages)

`packages/core/README.md` calls these "the product API spine — the stable surface plugins and consumers build against":

| Package | Owns | `ctx` key |
|---|---|---|
| `core/session` | Append-only `SessionEvent` log + in-memory store | `ctx.sessions` |
| `core/system-prompt` | Prompt-section and tool-schema assembly | `ctx.systemPrompt` |
| `core/tools` | Scoped tool registry + guarded execution pipeline | `ctx.tools` |
| `core/agent` | The `Agent` interface, live registry, `agent/*` events | `ctx.agents` |
| `core/agent-loop` | The default driver implementing that interface | `ctx.agentLoop` |
| `core/scope` | Per-agent scoped-registration primitive | library, no key |
| `llm/llm` | Message/stream vocabulary + adapter seam | `ctx.llm` |

(`docs/architecture.md`, §Core packages.) Two structural facts matter:

- `agent` owns the **public contract**; `agent-loop` is merely its **default implementation**, classified as role `bundle` in the capability graph — "extension packages depend on dsh-agent events and services, not on this package" (`docs/capability-seams.md`, `ctx.agentLoop` row). The loop itself is swappable.
- `scope` is a pure library primitive: `ScopeKey` is an opaque object identity (a live Agent is the key of its own scope), and one fact drives both visibility and lifetime — registrations through `agent.ctx` are scope-visible AND scope-lifetime (`docs/subsystems/scope.md`, `docs/glossary.md` §agent-scope). Per-agent persona/variants work by **shadowing** (most-specific-wins name resolution); `tools.restrict` filters the global tool set for one scope so a filtered-away tool is absent from the prompt *and* refuses execution, indistinguishable from a nonexistent one.

---

## 5. Events: three domains and the dispatch-mode contract

`docs/architecture.md` (§Events): "Events are the extension points, and picking the right domain is the first decision in most changes."

1. **Session events** — durable facts appended to the log and broadcast through the single `session/event` emit. Use when the fact must survive reload. The generated matrix (`docs/event-producer-consumer.md`) shows `session/event` with **28 listener packages** (persistence, projections, telemetry, token-meter, title, compaction, tools, approval, …) — the widest fan-out in the system.
2. **Agent events** (`agent/*`) — carry a live `Agent`: inbox, step, status, request, validation, continuation. `agent/pre-step` is a waterfall with **14 listener packages** (compaction, plan-mode, time-context, tmux-context, tool-cordis, tool-skill, hooks…), making it the primary "what does the model see / should this step run" interception point. `agent/turn-stopping` is the only `serial` event (hooks-claude-code, hooks-codex) — ordered, awaited, return-value semantics.
3. **Capability events** — attach policy and adapters to a seam (`fs/*`, `tools/*`, `telemetry/*`) without importing the loop, e.g. `fs/write-intent` and `fs/edit-intent` waterfalls listened to by `fs-observation-policy`.

Dispatch mode is mechanically enforced: the generated catalog checks event declarations against dispatch sites (`docs/cordis-primer.md`, `@mode` tag); the matrix itself is "resolved from the repository TypeScript Program" (`docs/event-producer-consumer.md`, footer).

### Turn/step flow (architecture level)

A **step** is one model request plus the tools it calls; a **turn** is zero or more steps — it opens before its first input is claimed and closes once nothing is owed (`docs/architecture.md` §Turn flow; `docs/glossary.md` §loop hierarchy; the sequence diagram in `docs/agent-lifecycle.md`):

```
turn/start
  claim next-step input + one queued message
  assemble prompt sections + tool schemas
  → agent/pre-step            reject | enter(messages)
     (a rejected or empty first claim still closes a durable turn with NO step — the log records the attempt)
     step/start
     append entered messages as user/message
     derive model history from the log
     agent/request → llm/stream → assistant/chunk* → assistant/message
     tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
     step/end
     tools owe another request, or next-step input arrived → claim → next step
  → agent/turn-stopping
turn/end
```

`turn/*`, `step/*`, `user/message`, `assistant/*`, `tool/*` are durable session events; the rest are live extension points. Input reaches the driver through **one inbox**; some messages wake it immediately while injected context waits until another message does. A **round** (glossary) is an outer policy iteration *containing* a turn — a goal round or one fresh-agent Ralph attempt — deliberately distinct from turn/step.

The load-bearing invariant: "**Model-visible means logged.** Anything that reaches a model request must be reconstructable from the log, and a runtime invariant asserts it" (`docs/architecture.md` §Session log). This is why a new model-visible input requires a new session event (extend `SessionEventMap`, render from the log). The persistence catalog pins the envelope: `type`, monotonic `seq`, epoch-ms `time`, `data`, optional `ignorable`, conditional `surfaceOp`/`sourceEventSeqs`; `SESSION_FORMAT_VERSION = 0` (pre-release, no compatibility implied); `SurfaceEventType` is exactly `user/message | assistant/message | tool/result`, and compaction replaces surface nodes via `{op:'replace', start, end}` while shadowing their seqs (`docs/persistence-catalog.md`).

### 5.1 The spine, package by package

`docs/subsystems/core.md` describes the same loop from the inside: the driver in `agent-loop` claims a queued prompt, opens a turn on the session log, assembles the request prefix through `ctx.systemPrompt` and derives history from the log, streams the model response through the LLM seam, dispatches tool calls through `ctx.tools`, and appends every model-visible fact back onto the log before the next step derives from it. The conversation vocabulary the loop moves — `Message`, `ContentBlock`, `StreamChunk`, the model request — is declared by `packages/llm` (`docs/subsystems/llm-streaming.md`). `scope/` is the one non-service package: a dependency-free library (`createScope`/`scopeOf`/`scopeTarget`) deliberately placed below `session/` and `system-prompt/` in the module graph "precisely so they can consume it without a cycle". `agent-loop` runs each driver inside `ctx.agents.withInitiator()`.

### 5.2 Agent ownership: the disposer is a capability

Programmatic creation through `ctx.agents.create()` / `resume()` returns an *owned handle* whose disposer is documented as a CAPABILITY: "among consumers, only the holder can tear this agent down. The registered factory provider is also a structural owner because the scoped agent depends on that provider's service API; provider unload stops and drains every live handle it made" (`docs/subsystems/core.md`, quoting the AgentHandle JSDoc at `packages/core/agent/src/index.ts`). `dispose()` stops the loop, awaits its exit, unregisters the agent, removes its session from the store, and finally unwinds its scoped world — an ordered composite teardown matching the defensive-patterns rule that dispose must reach quiescence, not just request it (`docs/defensive-patterns.md`).

### 5.3 Tool execution pipeline (architecture level)

`docs/tool-execution-pipeline.md` (curated graph) shows where policy runs *without changing the loop*: `tool/call` is logged BEFORE execution; then `tools/pre-execute` waterfall (hooks, permission, sandbox) → registered **monotonic guards** (deny or abstain; identity protected) → `ctx.approval` one-shot prompt (absent or unanswerable → deny) → `tools/execute` waterfall (timeout, retry, metrics — around dispatch) → the registered tool `execute()` body, with `fs/write-intent` / `fs/edit-intent` gates wrapping tool-fs mutations → tool-owned session events (`todo/write`, `fs/observed`, `hook/invoked`, `tool/code-dispatch`) → `tools/post-execute` waterfall (accept, block, replace, add context) → registry outer normalization (pipeline/result-snapshot throws become `isError`) → `ToolDefinition.finalizeContent` ("last content-only invariant") → `tools/result` synchronous notification of the frozen authoritative outcome → the single model-facing `tool/result` session event, with active-batch additionalContexts injected as `user/message` after recorded tool results.

Ordering is contractual (intro of the same page): "The `tools/pre-execute` waterfall runs first, monotonic guards run next, and the `tools/execute` and `tools/post-execute` waterfalls follow; the three waterfalls may transform a call." Any throw along the path funnels into normalization rather than crashing the loop.

---

## 6. Capability seams

`docs/glossary.md` §capability-seam (canonical definition): a seam is "a swappable capability with three roles: a **Service Definition** (the Cordis `Service` that owns its `ctx.<key>` and vocabulary types — an abstract class such as `ShellExecutor`, or a concrete registry such as `WebRuntime`, never a TypeScript `interface`), one or more **Service Providers**, and one or more **Consumers**". Roles normally occupy separate packages when they evolve independently; a package may own multiple roles when they are one concern (`dsh-llm` owns Definition + Consumer). "The seam is the complete capability, never one role."

Canonical example (`packages/shell`): `dsh-shell` (Definition) → `dsh-bash-local` / `dsh-bash-sandbox` / `dsh-pwsh-local` (Providers) → `dsh-tool-bash` / `dsh-tool-pwsh` (Consumers).

The generated capability table (`docs/capability-seams.md`) enumerates ~50 services with role classification (`core` / `seam` / `bundle`), implementations, and direct consumers. Representative rows:

- `ctx.llm` (seam): impls `llm-deepseek`, `llm-pi-ai`, `llm-replay` (test); consumers `agent-loop`, `compaction-basic`.
- `ctx.fs` (seam): impls `fs-local`, `fs-sandbox`, `fs-e2b`; consumer `tool-fs`; companion plugin `fs-observation-policy` via the `fs/*` event gate.
- `ctx.subprocess` (seam): impls local + e2b; consumers include bash executors, terminal-bash, lsp-stdio, and the out-of-process ACP/Codex/Claude Code subagent backends.
- `ctx.subagents` (seam): **six providers** — spawn-in-process, fork-in-process, acp, codex, claude-code, dsh-sdk — behind one interface; consumers `tool-subagent`, `tool-subagent-control`, `tool-ralph`.
- `ctx.approval` (seam): one-shot permission decisions over the `approval/request` waterfall; "absence fails closed to `unavailable`".
- `ctx.sandbox` + `ctx.sandboxPolicy` (seam/core split): consumers hand over the exact argv they are about to spawn; both bash-sandbox and fs-sandbox read the same policy so "bash and fs cannot confine to different roots".

The architectural payoff is stated explicitly (`docs/architecture.md` §Capability seams): "Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks." The e2b packages demonstrate this: one shared `ctx.e2b` handle owns the sandbox lifecycle while `fs-e2b` and `subprocess-e2b` are the two fundamental providers in the same Linux runtime.

### Where new behavior goes

`docs/architecture.md` ends with a 17-row routing table ("Where new behavior goes"); highlights: add a model provider → register its adapter on `ctx.llm`; add a model-facing capability → `ctx.tools` (its schema joins prompt assembly); per-session different capability set → compose an agent preset with an `isolate` realm; intercept a request/tool/turn → its `agent/*` or `tools/*` event, `agent/turn-stopping` stops a turn; add model-facing context → `agent.inject()` (lands in the next admitted request); add durable session state → extend `SessionEventMap` and render from the log; fork a live session → `ctx.sessions.fork(source, boundary?, childSessionId?)`.

---

## 7. Module graph: layering and hygiene

`docs/module-graph.md` (1638 lines, generated by `scripts/gen-module-graph.ts`) renders inter-package dependencies among `dsh-*` packages, **derived from each package's `peerDependencies`** — "the canonical runtime-dependency signal" — grouped by the `packages/<group>/<pkg>` hierarchy. The subgraph decomposition (flowchart TD with one subgraph per group) makes layering visible: `util` at the bottom (atomic-write, brand, home-paths, launch-environment, native-command, output-retention, timeout), then `llm`, `core` (agent/session/tools/system-prompt/scope), capability groups (fs, shell, terminal, subprocess, sandbox, web, skill, compaction, subagent, workflow, goal…), and composition groups (`boot`, `bundle`) on top.

Doc generation is itself a gated pipeline: `pnpm run gen-doc-graphs` / `verify-doc-graphs`, `gen-module-graph`, `gen-persistence-catalog` / `verify-persistence-catalog` (part of `doc-sync`); the graph atlas (`docs/graph-atlas.md`) classifies every diagram as `generated`, `hybrid generated`, or `curated`, and states the maintenance mode per page. Catalogs are byte-verified against source with "BEGIN GENERATED … do not edit" markers (e.g. `docs/subsystems/invariants.md` Cordis API section).

Two more generated catalogs complete the surface:

- **`docs/config-catalog.md`** (generated by `scripts/gen-config-catalog.ts`, verified in doc-sync): "Every `config:` block a `cordis.yml` entry can set" — for each loadable package, the verbatim config declaration its `apply`/constructor receives, with a `Requires:` line listing the service keys the plugin `inject`s ("its `cordis.yml` tree must also load providers for those services"). The generator cross-checks the runtime schemastery schema against the pasted declaration — "every schema-validated key, nested keys included, must be locatable on the declared config type — so the paste cannot hide a loader-accepted field." It is explicitly the **deployment-axis** reference, complementing the wiring axis (per-subsystem Cordis API regions) and the model axis (tool catalog).
- **`docs/tool-catalog.md`** (generated): every model-facing tool schema mapped to its owning package (per `docs/graph-atlas.md` index).

### 7.1 Runnable compositions as executable documentation

`examples/` ships seven small compositions that double as architecture demos: `agent-spine-demo` (the minimal runnable wiring of the six-package spine, referenced from `packages/core/README.md`), `headless-agent`, `acp-agent`, `jsonrpc-agent`, `mcp-memory`, `web-cordis`, `web-schedule` — each with its own generated `composition.md` graph (hybrid mode, per the atlas) showing exactly which rows its `cordis.yml` mounts. The atlas also renders the two app compositions: `apps/cli/composition.md` (dsh-base) and `examples/headless-agent/composition.md`.

---

## 8. Vendored vs product

The Cordis framework and its foundation libraries are vendored under `vendor/` and republished under the `@deepseek-ai` scope, "because every harness package declares the framework as a peer dependency: publishing the harness publishes this layer with it, and under the upstream names that publication would squat them on the registry" (`docs/rescope.md`). Nine vendored packages (name-mapping table):

| Directory | Upstream | Published | Role |
|---|---|---|---|
| `vendor/cordis/` | `cordis` | `@deepseek-ai/cordis` 4.0.0-rc.7 | Framework core: Context, Service, Fiber, events |
| `vendor/cosmokit/` | `cosmokit` | `@deepseek-ai/cosmokit` 1.8.1 | Shared utilities |
| `vendor/schemastery/` | `schemastery` | `@deepseek-ai/schemastery` 3.18.0 | Config schemas behind every plugin's `Config` |
| `vendor/loader/` | `@cordisjs/plugin-loader` | rescope | `cordis.yml` loading, plugin resolution |
| `vendor/include/` | `@cordisjs/plugin-include` | rescope | Config includes and patch overlays |
| `vendor/group/` | `@cordisjs/plugin-group` | rescope | Nested plugin groups (`isolate` realms) |
| `vendor/timer/`, `vendor/hmr/`, `vendor/logger-console/` | cordisjs | rescope | Disposal-aware timers, HMR, console logger |

The rename is script-owned (`scripts/rescope-vendor.ts`, with `--apply`, `:check` in the hygiene gate, and `--reverse`), deliberately NOT touching directory names, version ranges, the `cordis:` builtin prefix, the `cordis.yml` config family, or upstream runtime identifiers — so the vendored tree "still reads as an upstream snapshot". Everything above `vendor/` is product.

---

## 9. Design decisions & trade-offs (as evidenced in the repo)

1. **Replaceability over performance/simplicity.** Everything-is-a-plugin means even the agent loop is one swappable provider (`ctx.agentLoop` role `bundle`). Trade-off: indirection everywhere — ~219 packages, ~50 seams, key-based service lookup instead of imports. The repo manages the complexity cost with generated catalogs + verification gates rather than reducing indirection.
2. **Whole-row patch semantics, no deep merge.** Id-targeted patches replace a row's entire config; users must restate kept fields (`packages/bundle/base/README.md`, app-boot Known Limitations). Trade-off: more verbose overrides, but composition/dump/boot can never diverge on merge semantics, and patch application is trivially order-deterministic.
3. **Durable log as the single source of model truth.** "Model-visible means logged" with a runtime invariant asserting it; projections, titles, telemetry, persistence, query all derive from one stream; `assistant/chunk` events preserved for replay/UI fidelity. Trade-off: every new model-visible input is an event-type change (schema extension) rather than a free-form prompt edit.
4. **Fail-loud boot over degraded boot.** `assertEntriesLoaded`/`assertEntriesActivated` turn silent partial trees into startup rejections naming every unresolved plugin; empty patch files throw; incomplete bash-restore recipes "fail loud at load"; missing headless task is rejected before activation. The corollary is careful terminal hygiene on failure (`installFailLoud` awaits a bounded `release` teardown so a terminal-owning surface restores raw mode before exit).
5. **Mode bundles instead of build flags.** web vs headless are sibling bundles over the same base; platform differences (win32 bash/pwsh) live as `!!js` expressions on bundle rows. Trade-off: Windows quirks concentrated in one patch file, but the restore recipe must be complete or the load fails.
6. **Generated, verified documentation.** Module graph, capability seams, event matrix, tool catalog, persistence catalog, config catalog are all generated from the TypeScript Program / source with `verify-*` gates in doc-sync. Trade-off: doc tooling investment; payoff is architecture docs that cannot silently rot (the event matrix even lists "non-harness or undeclared event strings" it found in source).
7. **Peer-dependency graph as canonical architecture.** Deriving the module graph from `peerDependencies` (not devDeps/import scans) encodes the intended runtime coupling. Trade-off: graph reflects declared intent; completeness is guarded by the same generator (`scripts/gen-doc-graphs.ts` classification guard noted at the bottom of `docs/capability-seams.md`).
8. **Pre-release format honesty.** `SESSION_FORMAT_VERSION = 0` with "no compatibility implied" (persistence.md stance referenced from the catalog), and the README's all-caps "THERE WILL BE COMPATIBILITY-BREAKING CHANGES" — explicit, dated stance rather than silent drift.
9. **Guarded capability over trusted tools.** The tool pipeline runs every call through pre-policy → monotonic guards → approval → around-dispatch → post-policy with outer normalization, so a hook, policy, or wrapper defect becomes an `isError` tool result rather than a crashed loop (`docs/tool-execution-pipeline.md`). Trade-off: five interception layers add latency and conceptual weight; the payoff is that no single listener can take the harness down (mirrors the defensive pattern "Contain callback exceptions in the dispatcher", `docs/defensive-patterns.md`).
10. **Ownership as capability, not reference count.** Agent teardown authority lives with the creating consumer and the factory provider structurally — there is no global GC of agents; provider unload "stops and drains every live handle it made" (`docs/subsystems/core.md`). Trade-off: leak-on-forgotten-dispose is possible, mitigated by scope-lifetime registrations (one fact drives visibility AND lifetime) and Cordis effect unwinding.

---

## 10. Evidence appendix

| Claim | Evidence |
|---|---|
| Everything-is-a-plugin claim | `README.md` (top); `docs/architecture.md` §Cordis |
| Profile/bundle/patch layer order; whole-row replace | `docs/architecture.md` §Profiles and bundles; `packages/boot/app-boot/README.md` §Profiles; `packages/bundle/base/README.md` |
| Boot audit & fail-loud exports | `packages/boot/app-boot/README.md` export table (`boot`, `installFailLoud`, `assertEntriesLoaded`, `assertEntriesActivated`, `renderConfigDump`, `watchUserPatches`, `composeEntries`) |
| Live user-patch HMR; empty-file throws; `[]` disables | `packages/boot/app-boot/README.md` §Profiles (user-level preferences) |
| `.env` layering + bootstrap-only rejection | `packages/boot/app-boot/README.md` §Profiles, bullet `.env` |
| Core packages table | `docs/architecture.md` §Core packages; `packages/core/README.md` |
| agent-loop is swappable (role `bundle`) | `docs/capability-seams.md`, `ctx.agentLoop` row; `packages/core/README.md` |
| Turn/step flow + inbox + rejected-first-claim semantics | `docs/architecture.md` §Turn flow; `docs/agent-lifecycle.md` (sequence) |
| Turn/step/round vocabulary | `docs/glossary.md` §loop hierarchy |
| Waterfall/serial/emit/parallel contract + `@mode` enforcement | `docs/cordis-primer.md` (Five Ideas, Dispatch Modes, Waterfall Semantics) |
| Event domains; session/event fan-out (28 listeners); agent/pre-step 14 listeners; turn-stopping serial | `docs/event-producer-consumer.md` (generated matrix) |
| `agent/pre-step` declared waterfall at `runtime-types.ts:231`; `agent/turn-stopping` serial at `:278` | `docs/event-producer-consumer.md` rows, Declared-in column |
| Model-visible-means-logged invariant | `docs/architecture.md` §Session log |
| Session envelope fields; `SESSION_FORMAT_VERSION=0`; SurfaceEventType triple; replace op | `docs/persistence-catalog.md` (§Event envelope) |
| Seam three-role definition; shell canonical example | `docs/glossary.md` §capability-seam |
| Seam table rows (llm/fs/subprocess/subagents/approval/sandbox) | `docs/capability-seams.md` table |
| "one provider swap moves Bash, PTY, LSP" | `docs/architecture.md` §Capability seams |
| E2B shared-handle design | `docs/capability-seams.md`, `ctx.e2b` row |
| Where-new-behavior-goes table (17 rows) | `docs/architecture.md` final table |
| Tool pipeline stages & ordering contract | `docs/tool-execution-pipeline.md` (curated; intro paragraph + flowchart) |
| Spine flow narrative; scope-below-session rationale; withInitiator | `docs/subsystems/core.md` (§The spine, package by package) |
| Agent disposer-as-capability semantics | `docs/subsystems/core.md` (§Creation and ownership, AgentHandle JSDoc at `packages/core/agent/src/index.ts`) |
| Config catalog scope, Requires line, schema cross-check | `docs/config-catalog.md` (generated header) |
| Examples as runnable compositions (7) with generated composition.md | `examples/` listing; `docs/graph-atlas.md` table |
| Defensive patterns referenced (dispatcher containment, quiescent dispose) | `docs/defensive-patterns.md` |
| Module graph derived from peerDependencies; grouping | `docs/module-graph.md` header (generated) |
| Graph atlas modes (generated/hybrid/curated) + per-page maintenance mode | `docs/graph-atlas.md`; footers of generated pages |
| Vendored Cordis rescope (9 packages, why, what rename avoids) | `docs/rescope.md` |
| win32/POSIX shell twin rows via `!!js` | `packages/bundle/base/README.md` (platform gating paragraph) |
| web-app owns CLI args; rejects `0.0.0.0`; help starts no server | `packages/bundle/web-app/README.md` |
| headless one-shot lifecycle & exit code | `packages/bundle/headless/README.md` |
| Scope/shadowing/restriction semantics | `docs/glossary.md` §agent-scope; `docs/subsystems/scope.md` |
| Package/scale counts (54 groups, 219 packages) | measured: `ls packages/`, `find packages -maxdepth 2 -mindepth 2 -type d` |
| Group sizes (client 40, session 13, subagent 11, …) | measured: per-group `ls` |
| 44 subsystem pages; 4 postmortems; 688 agent notes | `docs/subsystems/` listing; `docs/postmortem/`; `find .agents/notes -name "*.md" | wc -l` = 688 |
| Base bundle row contents (timer/hmr/llm/session/typert/… ) | `apps/cli/composition.md` (generated) |
| Quickstart flow (settings→models→key, workspace, approval prompts) | `docs/user/guide/index.md` |
| Developer preview / breaking-changes stance; default port 3080 | `README.md` |

Residual notes for the parent: this report intentionally stays at architecture level; loop internals (cancellation, continuation, validation contracts) are in `docs/subsystems/core.md` and covered by dsh-03; the paper's formal metatheory is dsh-04; field-test data (129-plugin boot manifest, cost measurements) is dsh-05.