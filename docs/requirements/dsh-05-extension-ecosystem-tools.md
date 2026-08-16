# dsh-05 — DeepSeek Harness: Extension Ecosystem, Tool Execution, and Distribution Model

Repo under analysis (read-only local clone): `docs/references/deepseek-harness`. All paths below are relative to that repo root. Companion reports: dsh-01 (architecture), dsh-02 (Cordis paper), dsh-03 (lifecycle/session), dsh-04 (security), dsh-06 (process), dsh-07 (Orange Book), dsh-08 (lessons for pi-super-dev).

---

## 1. Overview

dsh's extension story is the productization of its "everything is a plugin" bet. A plugin is a TypeScript module exporting `apply(ctx)` (`docs/user/develop/basic/index.md`, "What is a plugin?") — that is the *entire* authoring contract. Everything above it is registered capability: tools, hooks, commands, skills, LLM adapters, UI cards, Web conversation nodes, sandbox backends, MCP bridges. The ecosystem spans four distribution tiers:

1. **In-tree** — 219 workspace packages under `packages/` (`docs/architecture.md`; counts measured in dsh-01 §1), all `@deepseek-ai/dsh-*`, gated by `pnpm run constraints` (invariants in `docs/cookbook/adding-a-package.md` §1).
2. **Bundles** — npm packages declaring `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`: a distribution format for Cordis config rows + the code they mount (`docs/user/develop/basic/publish.md`, "Two concepts, two manifests").
3. **Profiles** — directories under `$DSH_HOME/profiles/<name>` composing ordered bundles; `dsh plugin --profile <name> <args>` forwards to pnpm so "every pnpm verb works" (`publish.md`).
4. **Runtime-defined dynamic plugins** — versioned Cordis packages the agent itself defines and runs through `ctx.dynamicCordisRunner` with vm-sandboxed host halves (`docs/subsystems/extensions.md`).

The tool layer beneath all of it is a guarded execution pipeline with five interception stages and a mandatory canonical-output contract. The generator infrastructure (tool catalog booted from a real context, config catalog cross-checked against schemastery schemas) makes the ecosystem *mechanically documented* — a new tool package cannot ship silently undocumented because a completeness guard globs `packages/*/tool-*` (`docs/tool-catalog.md`, header).

Scale evidence: `docs/capability-seams.md` enumerates ~52 services with role classification (core/seam/bundle); `docs/tool-catalog.md` maps 28 tool packages → 60+ model-visible tool names; the MCP bridge is one package; skills merge six ranked filesystem roots.

---

## 2. Tool registration → schema-in-prompt → guarded execution

### 2.1 `ToolDefinition` and `defineTool`

A registered tool is `ToolSchema` (model-facing: name/description/parameters) plus a **mandatory canonical output declaration**, `execute`, host-only scheduler metadata, optional `finalizeContent`, and optional UI presenters (`docs/subsystems/tools.md`, §ToolDefinition — full interface with JSDoc at `packages/core/tools/src/index.ts`). The load-bearing rules:

- **Canonical JSON value contract.** `output: { schema, render, presentationMeta? }` — `execute` returns ONLY the value declared by `output.schema` (object/array/scalar/null roots allowed); the registry snapshots it as lossless JSON, validates, freezes, then projects model content via `render(args, value)`. "Do not return content blocks from the body or make callers parse prose for ids and fields" (`docs/cookbook/adding-a-tool.md`, "Declare and return one canonical JSON value").
- **Typed authoring via `defineTool`.** First-party tools never hand-validate: `defineTool({ name, description, parameters, output, execute })` validates model arguments against the `ParameterSchemaSpec` before `execute` runs, infers `InferArgs`/`InferValue` types, and ties both projectors (`docs/cookbook/adding-a-tool.md`, minimal shape; runtime arg validation design in `.agents/notes/implemented/architecture/2026-06-11-runtime-arg-validation.md`). Raw JSON-Schema `ToolDefinition`s register directly — "that is how MCP-sourced tools arrive" (`docs/cookbook/extension-cookbook.md`, §A tool plugin).
- **Enforced schema subset.** `ValueSchemaSpec` (string/number/integer/boolean/null/array/object/json/oneOf; explicit object nodes must declare `additionalProperties: true|false`; `oneOf` needs ≥2 branches, exact-one match) — "Raw schemas from subagents, workflows, MCP, and dynamic registrations use the wire-level counterpart of the author DSL. … unsupported keywords reject instead of being accepted without enforcement" (`docs/subsystems/tools.md`, §The enforced raw JSON Schema subset). Errors: `ToolArgsError` (`INVALID_ARGS`), `ToolOutputError` (`INVALID_TOOL_OUTPUT`).
- **The allowlist leak-guard.** `schemas()` builds the model-facing `ToolSchema[]` by explicit allowlist: "`output`/`execute`/`finalizeContent`/`timeoutMs`/`isConcurrencySafe`/`presentCall`/`presentResult` must never leak into a model request" (`docs/subsystems/tools.md`, §ToolDefinition).

### 2.2 The pipeline, stage by stage

`docs/tool-execution-pipeline.md` (generated Mermaid, curated maintenance mode) fixes the order contractually: "`tools/pre-execute` waterfall runs first, monotonic guards run next, and the `tools/execute` and `tools/post-execute` waterfalls follow; the three waterfalls may transform a call. Definition-owned `finalizeContent` and `tools/result` run afterward."

1. **`tool/call` logged BEFORE execution** — the session event is appended before any policy runs, so a denied call still exists in history; a UI pending card renders in parallel.
2. **`tools/pre-execute`** (waterfall) — the reorderable allow/deny/ask layer: hooks, permission, sandbox. `PreToolDecision = {kind:'allow'} | {kind:'deny'; reason} | {kind:'ask'; reason?}`. "`ask` runs only after an approval service returns `allowed-once` and otherwise denies … a non-grant, missing approval channel or service, or agent-less request becomes a denial" (`docs/subsystems/tools.md`, §Execution). **Input rewriting is deliberately excluded** — "Arguments cannot be rewritten because history, audit, UI, and execution must agree."
3. **Monotonic guards** — `ctx.tools.guard(guard)` with `ToolGuard` returning `string | undefined`: "Its return type deliberately has no allow result … a returned reason can only reduce permission, so a later listener cannot turn a denial back into permission" (`docs/subsystems/tools.md`, ToolGuard JSDoc). Registered after every pre-execute listener, before the body. Plain-context guard = global; `agent.ctx`-registered = per-agent (`tools.md` Cordis API region, `guard`).
4. **`tools/execute`** (waterfall, around-dispatch) — timeout, retry, metrics. A wrapper "may replace `exec.signal` … but cannot remove it. The registry fuses every replacement with the captured caller signal" (`tools.md`, ToolDispatchExecution). `timeoutMs` on the definition is enforced by `@deepseek-ai/dsh-tool-call-timeout-policy`, is NEVER model-visible, and "Declaring it asserts this tool forwards `exec.signal`" (cooperative-only hard kill).
5. **The tool body** — `execute(args, exec)` with frozen identity: `execute()` materializes arguments "as detached lossless JSON in one recursive pass, freezes that value before policy starts, and assigns an opaque `exec.token`" (`docs/cookbook/adding-a-tool.md`, "Execution identity is protected"). Filesystem mutations from `tool-fs` additionally pass `fs/write-intent` / `fs/edit-intent` waterfalls (companion plugin `fs-observation-policy` adds read-before-edit with "no schema change", per `docs/tool-catalog.md`, `@deepseek-ai/dsh-tool-fs` row). Tool-owned session events (`todo/write`, `fs/observed`, `hook/invoked`, `tool/code-dispatch`) are appended here.
6. **`tools/post-execute`** (waterfall) — `PostToolDecision`: accept / replace content OR value (never both; value replacement is revalidated and recomputes content+metadata) / block (removes the value, becomes an `isError` carrying corrective feedback) / attach `additionalContexts`. "Content replacement is presentation policy, not confidentiality policy: a listener that must hide the programmatic value blocks or replaces it" (`tools.md`).
7. **Registry outer normalization** — any throw anywhere (guards, wrappers, body, renderer, post-policy) funnels into a JSON-safe `isError` rather than crashing the loop; `ToolNotFoundError` maps to `UNKNOWN_TOOL`; "Unknown and throwing tools both become structured errors … so the call fails without ending the turn."
8. **`finalizeContent`** — definition-owned, synchronous, "last content-only invariant": "invoked exactly once for every normalized outcome, including pipeline failures that bypass `tools/post-execute` … must be total and must not throw" (`tools.md`, ToolDefinition JSDoc).
9. **`tools/result`** (emit) — "Observe the frozen, lossless-JSON final outcome. Listener failures are contained." The single model-facing `tool/result` session event follows; active-batch `additionalContexts` are injected as `user/message` FIFO *after* recorded tool results.

Cancellation semantics are specified per phase: pre-entry cancellation skips a not-yet-started body with `ABORTED_BEFORE_DISPATCH`; mid-flight replacement of a successful outcome with `ABORTED`; "already-started work is still drained and may retain a tool-owned structured error" (`tools.md`, `execute` JSDoc).

### 2.3 Scope, restriction, and Code Mode reach

- `ToolRestriction {allow?, deny?}` compiles per-scope sets, intersects multiple restrictions, and overlays the scope's OWN registrations (exempt), so "a delegated child keeps the tools it answers through"; a restricted-away global is absent from prompt AND refuses execution — indistinguishable from nonexistent (`tools.md`, §ToolRestriction; `docs/subsystems/scope.md` shadowing model).
- Every visible tool is automatically callable from Code Mode as `await tools.<name>(args)` with `ToolArgsMap`/`ToolOutputMap` derived from the same schemas; sub-calls "re-enter the complete guarded tool pipeline" and carry the parent token; under `mode: 'code'` a model-direct native-name call (no parent) "is denied as `UNKNOWN_TOOL` before the policy pipeline" (`tools.md`, ToolExecutionInput.parent JSDoc; `docs/tool-catalog.md`, `@deepseek-ai/dsh-tools` row).
- Parallelism is opt-in and fail-closed: `isConcurrencySafe(args)` — "Only `true` opts in; omission, exceptions, non-`true` returns, and invalid `defineTool` arguments are exclusive" (`tools.md`); the loop forms "exclusive barriers and rolling-pool parallel runs" from `executionMode`. Full contract in `.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md`.
- The **spill** seam handles oversized results: `spill-policy` (a `tools/post-execute` consumer) saves complete text through `ctx.spillStore` and returns "a model-facing locator plus retrieval hint"; capped glob results keep "the complete formatted list through the optional ctx.spillStore backend" (`docs/tool-catalog.md`, `@deepseek-ai/dsh-tool-fs-search` row; capability table `ctx.spillStore`).

### 2.4 Presentation vocabulary (UI without client coupling)

`presentCall`/`presentResult` return **`card`-tagged render intents** — generic/terminal/diff/search/read/web — a provider-neutral vocabulary where "tools never import a UI or transport type" (`docs/cookbook/adding-a-tool.md`, "How your tool renders in a UI"). Hard rules: purity ("these run on live streaming AND on session-log REPLAY … NO I/O, NO reading session state, NO clock/random"), replayable card data via `output.presentationMeta` persisted in `result.meta`, and "`defineTool` soft-validates the display path … display must never crash a replay." Design rationale: `.agents/notes/implemented/architecture/2026-07-02-tool-render-intent-union.md`.

---

## 3. Generated catalogs make the ecosystem checkable

- **`docs/tool-catalog.md`** — "this generator BOOTS each tool plugin on a real context and reads `ctx.tools.schemas()`, because a tool schema is not statically knowable (runtime-spread enums, concatenated descriptions, config-driven names, raw-JSON-Schema MCP tools). A completeness guard globs `packages/*/tool-*` and fails if any package is missing" (header). Per-package rows record deployment notes (e.g. `tool-subagent`'s registered name is load-time config; shipped aliases `subagent`/`subagent_fork` differ in `backgroundMode`: continuable-with-auto-settlement vs one-shot-foreground).
- **`docs/config-catalog.md`** (3151 lines) — every settable `config:` block verbatim, with `Requires:` lines listing injected service keys, cross-checked so "the paste cannot hide a loader-accepted field" (generator header).
- **`docs/capability-seams.md`** — role classification per service with a "classification guard" (footer: "hybrid: services are discovered from Cordis declarations; interface/implementation/consumer roles are classified in `scripts/gen-doc-graphs.ts` with a completeness guard").

---

## 4. Skills subsystem — including the `~/.agents/skills` zero-config claim

`ctx.skills` is a host+per-scope layered provider registry ("the shape the tools registry established over dsh-scale", `docs/subsystems/skills.md`, ctx.skills JSDoc). The shipped local provider scans six ranked roots (`skills.md`, Local discovery priority table):

| Rank | Source | Root |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | `Config.bundledSkillDir` |

**The Orange Book's "~/.agents/skills is read with zero config" claim is verified in source**: `packages/skill/skill-filesystem/src/index.ts:164` — `this.agentsHome = resolve(config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))` and `:254` — `{ path: join(this.agentsHome, 'skills'), source: 'user-agents', rank: USER_AGENTS_RANK }`. Skills authored for other harnesses (Claude Code's `~/.agents/skills` convention) are therefore discovered by default with no dsh-side configuration — an explicit cross-tool compatibility choice, not an accident. Project root = nearest ancestor containing `.git`, probed "through the filesystem service so remote or sandboxed workspaces do not fall back to the host filesystem boundary."

Model-facing behavior (`skills.md`, Session catalog and tool contract): `dsh-tool-skill` injects one durable `<system-reminder>` catalog at the first `agent/pre-step` containing only `name` + normalized, XML-escaped `description` (bound: `catalogDescriptionMaxLength`, default 500); before each later step it digests the rendered `<available_skills>` entries and, on change, appends a full replacement through `agent.inject()`; deleting all skills appends an explicit empty replacement; incomplete snapshots preserve the last-good view. The `skill({name})` tool validates kebab-case names, double-checks `isModelInvocable` before AND after loading the body, and returns `<skill_content>`/`<skill_resources>`/`<skill_instructions>` — "Body-only edits therefore change later tool calls without producing catalog messages." Invocation policy is two independent booleans (`modelInvocable`/`userInvocable`, frontmatter keys `disable-model-invocation`, `user-invocable`), so a skill can be user-only, model-only, or trusted-caller-only. Watcher: Chokidar with absent-path walk-down attach, LRU-bounded project watchers, and model-facing `write`/`edit` observations synchronously invalidating the provider when the target is catalog-relevant.

---

## 5. Commands — human dispatch without a model turn

`ctx.commands` registers slash commands whose handler executes "against the receiving agent without sending the command to the model" (`docs/subsystems/commands.md`, CommandDefinition.handler JSDoc). Key mechanics:

- **Log-only lifecycle, no turn**: "`command/run` is appended before the handler is invoked and `command/done` after settlement … Both are direct log-only appends — no turn wraps them. Admission misses (syntax or unknown name) log nothing" (`commands.md`, `execute` JSDoc). A `command/run` append failure fails loud; a `command/done` failure on the failure path is contained "so the handler's own error stays the reported failure."
- **Results are UI outcomes, not tool results**: `CommandResult = {kind:'success', text?, sourceEventSeq?} | {kind:'error', text}` — `sourceEventSeq` names "an earlier authoritative domain event that owns a richer presentation" so clients combine lifecycle with domain projection without parsing text.
- Scoped shadowing mirrors tools: agent-scoped registrations shadow globals; `@Remote list/execute` makes the registry Host-callable. `recordInput: false` avoids duplicating a payload already owned by the command's domain event.

---

## 6. Jobs — the kind-agnostic background runtime

`ctx.jobs` (`docs/subsystems/jobs.md`; design note `.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md`) unifies background bash, PTY sends, and subagent delegations under one registry with three model-facing tools (`job_kill`, `job_list`, `job_output` — `docs/tool-catalog.md`, `@deepseek-ai/dsh-tool-jobs` row: "background bash commands, PTY sends, and subagents are read, listed, and killed through the same three tools").

Producer contract: `JobStart {kind, label, outputLimitBytes?, owner?, run()}` — "The runtime preflights access and cleanup before invoking `run`; the producer owns execution resources while the runtime owns identity and lifecycle state." `JobHooks {cancel(reason?), done, readOutput?}` — `cancel` "Must be synchronous, idempotent, and eventually settle `done`"; `done` "resolves after the producer releases its resources, not merely when work finishes … Must not reject" (rejection converts to `failed`). Access control is "owner authorization, not id secrecy" — `JobId` is a branded `<kind>-N`; the job is fenced by the owner's session id, and "agent disposal cancels and awaits the job." The tool-side rule for producers (`docs/cookbook/adding-a-tool.md`, Long-running work): once published, use a task-owned signal, not `exec.signal` — "later outer-call cancellation stops waiting for the call but does not kill published work"; a successful background branch returns a typed canonical handle `{kind:'background', jobId}` whose prose "Code Mode must never parse … to recover the id."

---

## 7. MCP support

MCP is one package group: `packages/mcp/mcp-client` (`packages/mcp/README.md`; group has exactly the client bridge). From its README:

- **One plugin instance per server** in `cordis.yml` (stdio `command/args/env/cwd` or `streamable-http` `url/headers`), registering external tools on `ctx.tools` as native tools under `mcp__<serverName>__<rawName>` — "the same server-qualified shape Claude Code and Codex use."
- **Names are pure functions of `(serverName, rawName)`**, normalized to the 64-char `[A-Za-z0-9_-]` contract; "when replacement or truncation changes the name, a deterministic 12-hex-char hash … is appended so distinct tools never collapse." Duplicate `serverName` fails the later instance at load; a server listing a tool twice "is rejected as an invalid tool list"; "A foreign registration squatting on this server's namespace rolls back the whole generation (never a partial set), with a loud error."
- **Behavior**: activation awaits `listTools()` and registers before the first turn; `failOnStartupError` (default false) chooses loud vs tool-less activation; `notifications/tools/list_changed` re-syncs generation-wise (a fetch failure keeps the previous generation registered); execution goes through `client.callTool({name: rawName, arguments}, {signal})` — "the public name is never sent to the server"; MCP `isError` "rejects the call through the registry's error path."
- **Reconnect supervisor**: exponential backoff (`initialDelayMs` 500 doubling to `maxDelayMs` 30000), "budgeted per outage: after `reconnect.maxAttempts` consecutive failures the server's tools are unregistered and reconnection stops until an HMR reload"; "A connection that survives past `maxDelayMs` resets the budget, so an occasionally-crashing server recovers indefinitely while a crash-looping one … still exhausts the cap."
- **Declared limits** (README, Known Limitations): "Tools are the only bridged MCP capability — Resources and Prompts have no harness consumer and are deferred"; startup timeout inherited from the MCP SDK's 60s; native non-text rendering lossy (placeholders in model context, JSON blocks preserved in the execution-local canonical value); unsupported advertised `outputSchema` vocabulary falls back to unconstrained `JsonValue`.

The cookbook frames the whole approach in one line: "MCP | one plugin per server: discover tools → `ctx.tools.register()`" (`docs/cookbook/extension-cookbook.md`, feature → mechanism map) — MCP tools get the full guarded pipeline, spill policy, and Code Mode reach for free because they arrive as ordinary registrations.

---

## 8. API gateway, web server, and conversation nodes

- **`ctx.webServer`** (`docs/subsystems/web-server.md`) is deliberately dumb: "a single `node:http` plugin providing … a named-route registry, index.html transform callbacks, and one fallback handler … It is not part of the agent loop and not a capability seam; it knows no harness concepts." Match order fixed: exact table → longest prefix → the single fallback seat ("one owner only, a second registration throws"), claimed by `dsh-host-frontend-static` with locked SPA semantics (405 non-GET/HEAD, 403 traversal, miss → `index.html` 200, unknown extensions octet-stream).
- **API Gateway** (`docs/api-gateway.md`) is the typed Host↔Client RPC surface: business services declare unary methods with `@Remote` / `@RemoteScope(key)` on `TypertRemoteService` subclasses; "Unmarked methods do not enter the generated Client types … and cannot be called through `ctx.remote`." Complex Host objects cross the wire as identities declared in `TypertLookupMap` and resolved via `ctx.typert.lookups` ("an `Agent` parameter named `agent` … produces an `agentId` wire field"). Streaming protocols (session events, incremental data) explicitly do NOT use Remote descriptors — "they may use the same Connection but do not use Remote method descriptors."
- **Conversation nodes** (`docs/cookbook/adding-a-conversation-node.md`) are the Web Client Chat extension path: a business row correlates a durable event family (stable id on every event, e.g. `review/start|progress|end` all carrying `reviewId`) into one Context, incrementally builds State replayable "in ascending log `seq`" with "no live-only memory," publishes typed Step data (`ConversationStepDataMap` merge), and renders a keyed Chat node (`ChatNodeDataMap`) — "without scanning the Session window or other rendered nodes." Window semantics are explicit: updates-only window keeps a pending Context and builds no State until an older page supplies the start; a terminal/checkpoint event may carry whole-value fallback state. Rationale: `.agents/notes/implemented/architecture/2026-08-09-client-conversation-node-assembly.md`.
- **Web access** (`docs/subsystems/web.md`): one `ctx.web` seam, two operations (search/fetch) — "Search and fetch share no request schema and no business logic, but they are deliberately one `ctx.web` middle layer: one provider-selection policy owner, one abort/error vocabulary" — with the cost honestly named ("the parallel `searchX`/`fetchX` method pairs … that parallelism is intentional, not a missed extraction"). Providers register capabilities, never tools; `maxResults` is a consumer-owned bound "enforced on the way back by the seam."
- **Attachments** (`docs/subsystems/attachment.md`): "The attachment seam separates binary image ownership from the session log … Session events and model-visible `ImageBlock`s contain that reference and metadata, never a browser object URL, host temporary path, provider URL, or base64 payload"; persist-before-event ("its images move below `<DSH_HOME>/attachments/v1` before the user event is appended"); `AttachmentId` is opaque — "consumers must neither parse that representation nor derive a filesystem path from it."

---

## 9. Code-review skill maintenance + stacked PR review (meta-ecosystem)

Two cookbook pages document how the repo's own review culture is maintained as ecosystem artifacts:

- **`docs/cookbook/maintaining-dsh-code-review.md`**: a single designated operator runs a private daily tool (2-UTC-day overlap; weekly recovery 7-day) that selects merged PRs reachable from `origin/master` (250-commit acquisition cap; unreachable stacked-squash merges logged to `skipped-pulls.json` and skipped, never aborting), collects pre-merge human review feedback "with commit anchors," diffs feedback-time vs landed patches, then two independently configured reviewer adapters classify authorship/adoption and draft a complete revised `SKILL.md` — "blocking findings loop until both approve," gated by `pnpm run doc-sync && lint`. The operator contract is explicit: "Do not defer to 'the reviewers approved'; the maintainer contract is that the operator makes the final decision," with discard/batch/promote decisions, a promote helper that "stops on skill drift rather than overwriting newer guidance," and fail-closed provider-outage handling ("A single batch whose adapter response fails schema or id validation is failed closed at the batch level … it never collapses a total-provider outage into 'no candidate'"). "Days without a skill update are the workflow behaving correctly, not a stall."
- **`docs/cookbook/responding-to-pr-review-on-a-stack.md`**: one worktree per PR branch; GitHub's official stack object is authoritative ("`PullRequest.stack` and `stackEntry.position` prove that GitHub recognizes it"); "A fix lands on the PR that INTRODUCED the issue, then flows up-stack"; each review fix remains a distinct commit; force-push must be lease-protected ("raw `--force` is forbidden"); and a trust-but-verify rule for delegated work: "Treat delegated fixes as trust-but-verify: a sub-agent's report describes intent, not necessarily what landed. Re-run the gates yourself on the actual tree, and for a regression guard, prove it FAILS on the unfixed code … A sub-agent that reframes a problem as already handled is a signal to dig in personally."

---

## 10. Developer experience, end to end

The on-ramp is deliberately short and layered (`docs/user/develop/`):

1. **First plugin** (`basic/index.md`): a module exporting `apply(ctx)` + `name` — "That is the complete configuration" — loaded live via `pnpm dsh web --patch ./scratch-plugin/cordis.yml`.
2. **First tool** (`basic/tool.md`): the ~20-line `greet` tool; "`inject` makes Cordis wait for the tool registry"; ask the Web UI "Use the greet tool to greet Ada" and see the round trip.
3. **Configuration** (`basic/config.md`) then **packaging** (`basic/publish.md`): the bundle/profile manifests, `dsh plugin --profile demo add ./hello-plugin` initializing the profile with `dsh-base` as first bundle and appending to `dsh.profile.bundles`. Out-of-tree discovery: "Add the `dsh-plugin` topic to your plugin repository for discoverability" (`README.md`, Community and support) — npm + a GitHub topic is the entire distribution mechanism.
4. **Framework docs** (`develop/framework/{index,events,service}.md`) and the capability-seam practice (`develop/practice/`, e.g. `llm-adapter.md`).
5. **LLM adapter cookbook** (`docs/cookbook/adding-an-llm-adapter.md`): `LlmAdapter extends` + `ctx.llm.registerAdapter(['my-provider'], …)`, "Registration is effect-based (HMR-safe); one adapter per provider route — duplicates throw, and multi-route registration is all-or-nothing." Protocol obligations are the verified contract: "Emit `usage` BEFORE `finish`; emit NOTHING after `finish`"; "Tool-call `arguments` are RAW JSON strings end-to-end"; "Errors have exactly two sanctioned paths"; "a `GenerateOptions` field your provider cannot honor … throw `LlmError(..., 'UNSUPPORTED')` rather than silently dropping it."
6. **In-tree contribution** (`docs/cookbook/adding-a-package.md`): a file-by-file checklist with mechanically enforced invariants (`pnpm run constraints`), a naming-role decision table (Registry/Runtime/Resolver/Gateway/Provider/Backend/Handle…: "Use it when / Do not use it when"), and a canonical README structure whose "Model Experience" section (What the model sees / Token effect / KV Cache effect) and "Known Limitations and Deferred Work" are verified by `scripts/verify-package-readme-model-experience.ts` and `verify-package-readme-limitations.ts`.

The HMR dividend makes the whole loop fast: "editing the entry triggers disconnect + reconnect without process restart" (MCP README); "Plugin hot-reload | every registration is a `ctx.effect` → vendored HMR just works" (`extension-cookbook.md`, feature map).

---

## 11. Design decisions & trade-offs

1. **Registration-as-capability everywhere.** `ctx.tools.register/guard/restrict`, `ctx.commands.register`, `ctx.skills.registerProvider/register` all return "the exact disposer"; disposal semantics (quiescence, cache invalidation, scoped-layer removal) are uniform. Trade-off: every author must maintain disposer discipline (Cordis's known unverified-witness gap, dsh-02 §5); dsh mitigates with the invariants registry and package-owned `./invariant` companions.
2. **Policy layering with a monotonic core.** Reorderable waterfall (pre-execute) for ecosystem policy + non-reorderable guards for owner invariants + around-dispatch for cross-cutting runtime concerns. The split is principled: "owner policy that must not be reordered remains a registered guard" (`docs/tool-execution-pipeline.md`). Trade-off: five interception stages add latency and conceptual weight; payoff — no single listener can take the loop down, and permission can only ever *shrink*.
3. **Canonical value vs model content separation.** One value, two projections (`render` for the model, `presentationMeta`+cards for UIs), with the canonical value never persisted ("Replay reproduces presentation but cannot reconstruct canonical intermediate values", `tools.md`). Trade-off: two projection surfaces per tool; payoff — Code Mode gets a real programmatic API, UIs get replayable cards, and confidentiality policy has an honest place to act (block/replace value).
4. **Identity protection over convenience.** Frozen args, opaque tokens, immutable call identity ("wrappers cannot create a second, disagreeing identity"), no input rewriting, no model-visible host metadata. Trade-off: a policy plugin cannot redact/rewrite arguments in flight; dsh's answer is that history, audit, UI, and execution must agree — rewriting would fork the truth.
5. **Generated catalogs as the ecosystem contract.** Tool/config/seam/event docs are generated and gate-verified; the tool catalog even boots real plugins because "a tool schema is not statically knowable." Trade-off: heavy doc-tooling investment and per-package README contract ceremony (Model Experience/KV-cache sections with verifiers); payoff — ecosystem state cannot silently rot, and a new tool cannot ship undocumented.
6. **npm-as-registry with a thin discovery layer.** Bundles are plain npm packages; profiles are pnpm-managed directories; discoverability is a GitHub topic (`dsh-plugin`). No marketplace, no registry service. Trade-off: weak central quality control; payoff: zero infrastructure, versioning for free, pnpm's whole verb surface, HMR-driven hot swap, and the `@deepseek-ai` peer-dependency rescope story stays coherent (`docs/rescope.md`).
7. **Zero-config cross-tool skill compatibility.** Reading `~/.agents/skills` and `<projectRoot>/.agents/skills` by default (rank 500/200) imports another harness's skill ecosystem wholesale. Trade-off: implicit trust in foreign skill files and duplicate-name collisions resolved by rank rather than consent; payoff: instant skill gravity for migrating users.
8. **Honest, bounded MCP bridge.** Generation-wise registration (rollback on conflict, never partial), pure-function names, budgeted reconnect — but Resources/Prompts deferred and startup timeout inherited from the SDK. The declared-limitations discipline is itself the pattern: every package README carries a verified Known Limitations section.
9. **The loop owns nothing the seams can own.** Commands bypass the model entirely; jobs externalize background lifetime; web/attachments/fs/sandbox are swappable providers; Code Mode reuses the same pipeline. Trade-off: the everything-is-a-plugin indirection tax (219 packages, ~52 seams); payoff: "one provider swap changes the whole product" (dsh-01 §6).
10. **Review culture as maintained skill.** The code-review skill is updated by a scheduled human-gated pipeline with dual-adapter consensus and evidence-linked promotion — treating the repo's own review guidance as a data asset with provenance (feedback URLs, landed ranges in the manifest).

---

## 12. Evidence appendix

| Claim | Evidence |
|---|---|
| Plugin = module exporting apply; "complete configuration" | `docs/user/develop/basic/index.md` |
| greet minimal tool + inject waits for registry | `docs/user/develop/basic/tool.md` |
| defineTool validation/inference; identity protection; canonical-value rules; background pattern; presenter purity; Code Mode reach | `docs/cookbook/adding-a-tool.md` (all sections) |
| ToolDefinition fields incl. output/finalizeContent/timeoutMs/isConcurrencySafe/presentCall/presentResult; allowlist leak-guard | `docs/subsystems/tools.md` §ToolDefinition |
| Pipeline order contract; pre/guards/around/post/finalize/result; fs gates; Code Mode sub-calls | `docs/tool-execution-pipeline.md` (generated flow + prose) |
| PreToolDecision/PostToolDecision semantics; no input rewriting; value/content exclusivity; containment; UNKNOWN_TOOL | `docs/subsystems/tools.md` §Execution |
| ToolGuard monotonic (no allow result); ctx.tools.register/guard/restrict/schemas/execute JSDoc; ABORTED/ABORTED_BEFORE_DISPATCH | `docs/subsystems/tools.md` Cordis API region |
| Enforced JSON Schema subset; MCP/subagent/workflow raw schemas; ToolArgsError/ToolOutputError | `docs/subsystems/tools.md` §enforced subset |
| Tool catalog boots real plugins; completeness guard; per-package rows (tool-subagent aliases, fs-search spill, jobs trio, run_code reserved transport, exit_plan_mode churn-avoidance) | `docs/tool-catalog.md` header + Tool Package Map |
| Card vocabulary (generic/terminal/diff/search/read/web); purity rules; presentationMeta replay | `docs/cookbook/adding-a-tool.md`; `docs/subsystems/tools.md` §presentation |
| Skills roots/ranks; agentsHome default; kebab-case; invocation policy frontmatter keys; session catalog digest/inject replacement; double policy recheck | `docs/subsystems/skills.md`; `packages/skill/skill-filesystem/src/index.ts:164,247,254`; `docs/config-catalog.md:1880` |
| Commands: no model message; command/run + command/done log-only; sourceEventSeq; scoped shadowing | `docs/subsystems/commands.md` |
| Jobs producer contract; cancel/done/readOutput; owner fencing; `<kind>-N`; three control tools | `docs/subsystems/jobs.md`; `docs/tool-catalog.md` (`@deepseek-ai/dsh-tool-jobs`) |
| MCP: naming/normalization/rollback; reconnect budget; declared limits; one-line cookbook framing | `packages/mcp/README.md`; `packages/mcp/mcp-client/README.md` (Config/Behavior/Known Limitations); `docs/cookbook/extension-cookbook.md` feature map |
| webServer dumbness; fallback seat; SPA fallback semantics | `docs/subsystems/web-server.md` |
| API gateway @Remote/@RemoteScope; TypertLookupMap; streaming excluded | `docs/api-gateway.md` |
| Conversation node event-family/assembler/window rules | `docs/cookbook/adding-a-conversation-node.md` |
| Web seam two-operations rationale; maxResults enforcement; truncated | `docs/subsystems/web.md` |
| Attachment persist-before-event; opaque id; no base64 in events | `docs/subsystems/attachment.md` |
| Code-review skill maintenance workflow; operator contract; fail-closed adapters | `docs/cookbook/maintaining-dsh-code-review.md` |
| Stacked PR rules; trust-but-verify; prove-guards-fail | `docs/cookbook/responding-to-pr-review-on-a-stack.md` |
| Bundle/profile manifests; dsh plugin forwards to pnpm; dsh-plugin topic | `docs/user/develop/basic/publish.md`; `README.md` |
| Package checklist invariants; naming role table; Model Experience/KV Cache README contract + verifiers | `docs/cookbook/adding-a-package.md` |
| LLM adapter shape/protocol obligations; UNSUPPORTED throw rule | `docs/cookbook/adding-an-llm-adapter.md` |
| Config catalog generator cross-check; Requires lines | `docs/config-catalog.md` header |
| Capability seam classification guard | `docs/capability-seams.md` footer |
| Parallel tool-call contract | `.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md` (referenced from tools.md) |
| Agent Notes referenced (arg validation, render-intent union, jobs runtime, conversation node assembly, skill maintenance) | `.agents/notes/implemented/{architecture,feature,process}/…` as cited inline |

Residual notes for the parent: this report covers the ecosystem/tool-execution/distribution axis; loop internals are dsh-03, security/sandbox dsh-04, process/ci dsh-06, field data dsh-07. The `dsh-plugin` GitHub topic is the only out-of-band discovery mechanism found (no marketplace/registry service in-repo).
