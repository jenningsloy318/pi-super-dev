# Pi Extension API Research — Standalone Orchestration Engine

> Research date: 2026-07-03
> Scope: Full surface area of Pi Coding Agent extension API, subagent spawning mechanisms, and architecture for a self-contained orchestration engine in `@jenningsloy318/pi-super-dev`.

---

## 1. Full ExtensionAPI Surface Discovered

The `ExtensionAPI` type is exported from `@earendil-works/pi-coding-agent` (the Pi Coding Agent core package). Based on analysis of all consumers (`pi-subagents` v0.32.0, `pi-intercom` v0.6.0, `pi-simplify` v0.2.2, `@agwab/pi-subagent` v0.3.6, `@agwab/pi-workflow` v0.1.2, and bundled extensions in `~/.pi/agent/extensions/`), the following API surface has been confirmed:

### 1.1 Core Registration Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `registerTool` | `(tool: ToolDefinition<TParams, TDetails>) => void` | Register an LLM-callable tool with schema, execute, and render hooks |
| `registerCommand` | `(name: string, opts: CommandDefinition) => void` | Register a slash command (`/name`) |
| `registerMessageRenderer` | `<T>(type: string, renderer: MessageRendererFn<T>) => Component` | Register custom TUI rendering for message types |

### 1.2 Event System

| Method | Signature | Description |
|--------|-----------|-------------|
| `on(event, handler)` | `(event: string, handler: (event, ctx: ExtensionContext) => void) => void` | Subscribe to Pi lifecycle events |
| `events.on(event, handler)` | Returns unsubscribe function. Global event bus for cross-extension communication |
| `events.emit(event, payload)` | Emit events to the global bus |

**Known lifecycle events** (from all extensions observed):
- `session_start` — new Pi session begins (handler receives `(_event, ctx)`)
- `session_shutdown` — session ending
- `before_agent_start` — pre-turn hook (receives `event.prompt`)
- `agent_start` / `agent_end` — LLM turn starts/ends
- `tool_call` — LLM requests tool execution (receives `event.toolName`, `event.input`)
- `tool_execution_start` / `tool_execution_end` — tool lifecycle (receives `event.toolName`, `event.args`)
- `tool_result` — tool returns result (receives `event.toolName`)
- `message_end` — assistant message finalized (receives `event.message` with `.role`, `.content`, `.usage`)

### 1.3 Utility Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `sendMessage` | `(opts: { content: string, display?: boolean }) => void` | Inject a message into the conversation |
| `getThinkingLevel` | `() => string \| undefined` | Get current thinking/reasoning level |
| `getSessionName` | `() => string \| undefined` | Get the named session identifier |

### 1.4 ToolDefinition Interface

```typescript
interface ToolDefinition<TParams, TDetails> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;          // Short description for LLM tool selection
  promptGuidelines?: string[];     // Usage guidelines injected into LLM context
  parameters: TParams;             // TypeBox schema for tool parameters
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal,
    onUpdate: ((result: AgentToolResult<TDetails>) => void) | undefined,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<TDetails>> | AgentToolResult<TDetails>;
  renderCall?(args: unknown, theme: Theme): Component;
  renderResult?(result: AgentToolResult<TDetails>, options: RenderOptions, theme: Theme, context: RenderContext): Component;
}
```

### 1.5 ExtensionContext (ctx)

The `ctx` object provided to command handlers and tool execute functions:

| Property | Type | Description |
|----------|------|-------------|
| `cwd` | `string` | Current working directory |
| `hasUI` | `boolean` | Whether TUI is available |
| `ui.notify(msg, level)` | Function | Show notification in TUI |
| `ui.confirm(title, msg, options?)` | Function | Show confirmation dialog |
| `ui.setToolsExpanded(bool)` | Function | Collapse/expand tool output |
| `ui.setWidget(key, component)` | Function | Set a persistent TUI widget |
| `ui.requestRender()` | Function | Force TUI re-render |
| `signal` | `AbortSignal` | Cancellation signal |
| `model` | `{ provider: string, id: string }` | Current model info |
| `modelRegistry.getAvailable()` | Function | List available models (returns array with `provider`, `id`) |
| `sessionManager.getSessionFile()` | Function | Current session `.jsonl` file path |
| `sessionManager.getSessionId()` | Function | Current session identifier |
| `sessionManager.getEntries()` | Function | Session history entries |
| `getContextUsage()` | Function | Token usage stats (`{ tokens, contextWindow }`) |
| `getTool(name)` | Function | Get another registered tool by name |
| `output(text)` | Function | Write text to conversation (in command handlers) |

### 1.6 CommandDefinition

```typescript
interface CommandDefinition {
  description: string;
  getArgumentCompletions?(prefix: string): CompletionItem[] | null;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
}
```

### 1.7 AgentToolResult

```typescript
interface AgentToolResult<TDetails = unknown> {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: TDetails;
}
```

---

## 2. Agent/Task Spawning Mechanisms

There are **three distinct mechanisms** for spawning subagents in the Pi ecosystem:

### 2.1 `pi-subagents` (nicobailon) — High-Level Orchestration Tool

- **Package**: `pi-subagents` v0.32.0
- **Mechanism**: Registers a `subagent` tool that the LLM calls. Internally spawns Pi child processes using `getPiSpawnCommand()` which resolves to the `pi` CLI binary.
- **Process spawn**: `child_process.spawn("pi", [...args])` with child running in a fresh session.
- **Modes**: Single, parallel (concurrent tasks), chain (sequential pipeline), async/background
- **Features**: Fork context (copy parent session), worktree isolation, intercom messaging, control/interrupt, structured output, acceptance criteria, nested runs, model fallback
- **Key env vars**: `PI_SUBAGENT_CHILD=1`, `PI_SUBAGENT_PARENT_SESSION`, `PI_SUBAGENT_DEPTH`
- **State persistence**: File-based in `~/.pi/agent/sessions/{parentSessionId}/`, async state in `~/.pi/agent/extensions/subagent/async/`
- **Extension entry**: Default export is `registerSubagentExtension(pi: ExtensionAPI)`
- **Source**: `/home/jenningsl/.pi/agent/npm/node_modules/pi-subagents/src/`

### 2.2 `@agwab/pi-subagent` v0.3.6 — Lower-Level Programmatic Runtime

- **Package**: `@agwab/pi-subagent` (bundled in pi-workflow)
- **Used by**: `@agwab/pi-workflow` as a bundled dependency
- **Mechanism**: Provides a programmatic `runSubagent(options)` function that spawns Pi processes with fine-grained backend control.
- **Import**: `import { runSubagent, getSubagentStatus, interruptSubagent } from "@agwab/pi-subagent/api"`
- **Backends**:
  - `headless` — spawns a detached Pi process in the background (primary mode pi-workflow uses)
  - `inline` — runs in the current process context
  - `tmux` — spawns in a tmux pane for visibility
- **API surface** (from `src/api.ts`):
  ```typescript
  runSubagent(options: RunSubagentOptions): Promise<ResultEnvelope | ParallelRunResult>
  getSubagentStatus(options: RunStatusRef): Promise<RunStatusSnapshot | null>
  getSubagentLogs(options: RunStatusRef): Promise<RunLogsSnapshot | null>
  waitForSubagent(options: WaitForRunOptions): Promise<WaitForRunResult>
  interruptSubagent(options: InterruptRunOptions): Promise<InterruptRunResult>
  reconcileSubagentRun(options: ReconcileRunOptions): Promise<ReconcileSubagentRunResult>
  ```
- **RunSubagentOptions** (key fields):
  ```typescript
  {
    backend?: "headless" | "inline" | "tmux",
    agent?: string,           // agent name to load from .md
    task?: string,            // task prompt
    systemPrompt?: string,    // override system prompt
    model?: string,           // model override (provider/id)
    thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
    tools?: string[],         // tool allowlist
    skills?: string[],        // skill paths
    extensions?: string[],    // extension paths to load in child
    cwd?: string,
    async?: boolean,
    onComplete?: "detach" | "notify",
    asyncDependency?: "needed-before-final" | "background",
    timeoutMs?: number,
    runsDir?: string,         // relative artifact root under cwd
    correlationId?: string,   // external tracking ID
    workspace?: "shared" | "worktree" | "auto",
    worktree?: boolean | string,
    worktreePolicy?: "always" | "never" | "auto",
    sandbox?: boolean | { allowedDomains: string[] },
    captureToolCalls?: boolean,
    mode?: "single" | "parallel",
    tasks?: Array<{ agent, task, ... }>,  // parallel mode
    concurrency?: number,
    parentSessionId?: string,
    signal?: AbortSignal,
  }
  ```
- **ResultEnvelope** (return type):
  ```typescript
  {
    runId: string,
    attemptId: string,
    backend: string,
    status: "completed" | "failed" | "cancelled" | "running" | "pending",
    failureKind: string | null,
    cwd: string,
    durationMs?: number,
    exitCode: number | null,
    artifacts: ArtifactRef[],  // { type, path, bytes? }
    metadata: { contextLengthExceeded: boolean, ... },
    workspace: { mode, cwd },
    sandbox: { enabled },
    correlationId?: string,
  }
  ```
- **Source**: Found at `.worktree/01-pi-super-dev-workflow-plugin/node_modules/@agwab/pi-workflow/node_modules/@agwab/pi-subagent/src/`
- **Also registers**: A `subagent` tool and `/subagent panel` command (as a Pi extension)

### 2.3 Direct Pi CLI Process Spawn (Lowest Level)

Both packages above ultimately spawn the Pi CLI binary. The spawn looks like:

```typescript
import { spawn } from "node:child_process";

// pi-subagents resolves the binary via getPiSpawnCommand()
// The binary is "pi" on PATH (from @earendil-works/pi-coding-agent)
spawn("pi", [
  "--print",                    // Non-interactive headless mode
  "--system-prompt", file,      // System prompt from file
  "--prompt", taskText,         // Task prompt
  "--model", "provider/model",  // Model specification
  "--tools", "tool1,tool2",     // Tool allowlist
  "--resume", sessionFile,      // Resume from existing session (optional)
], {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PI_SUBAGENT_CHILD: "1",
    PI_SUBAGENT_DEPTH: String(depth + 1),
    PI_SUBAGENT_PARENT_SESSION: parentSessionId,
  },
  detached: true,  // for async/headless runs
})
```

---

## 3. State Persistence Options

### 3.1 Session Files (Built-in Pi)
- Pi stores sessions as `.jsonl` files in `~/.pi/agent/sessions/`
- Each line is a JSON object representing a conversation turn
- Sessions can be resumed with `--resume <path>`
- The `ctx.sessionManager` provides programmatic access

### 3.2 Extension-Specific Storage Patterns

| Package | Storage Location | Format |
|---------|-----------------|--------|
| `pi-subagents` | `~/.pi/agent/extensions/subagent/async/` | JSON run status files |
| `pi-subagents` | `~/.pi/agent/extensions/subagent/results/` | Result notification files |
| `pi-subagents` | `~/.pi/agent/sessions/{parentId}/{runId}/` | JSONL session + artifacts |
| `@agwab/pi-subagent` | `{cwd}/.pi/workflow-subagents/{runId}/{taskId}/` | Run artifacts, results, logs |
| `pi-workflow` | `{cwd}/.pi/workflows/{runId}/` | Run records, task artifacts, source cache |
| `pi-intercom` | Unix socket broker | Live message passing (ephemeral) |

### 3.3 Recommended for Our Engine

```
{cwd}/.pi/super-dev/
├── runs/
│   └── {runId}/
│       ├── state.json              # Pipeline state (current stage, status, timestamps)
│       ├── config.json             # Run configuration (task, model, options)
│       ├── stages/
│       │   ├── 01-classify/
│       │   │   ├── result.json     # Stage result + gate verdict
│       │   │   ├── output.md       # Agent output text
│       │   │   └── session.jsonl   # Pi session file (for resume)
│       │   ├── 02-requirements/
│       │   └── ...
│       └── artifacts/              # Cross-stage shared artifacts
└── index.json                      # Run index (for /super-dev status)
```

---

## 4. Recommended Architecture for Built-in JS Orchestration Engine

### 4.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  @jenningsloy318/pi-super-dev                                       │
│                                                                     │
│  src/extension.ts (default export)                                  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  1. pi.registerTool("super_dev_run", ...)                     │  │
│  │     → LLM calls this to start/resume pipeline                 │  │
│  │  2. pi.registerCommand("super-dev", ...)                      │  │
│  │     → User triggers via /super-dev                            │  │
│  │  3. pi.on("session_start", ...) → restore active runs         │  │
│  └──────────────────────┬────────────────────────────────────────┘  │
│                          │                                           │
│  src/engine/             │                                           │
│  ┌──────────────────────▼────────────────────────────────────────┐  │
│  │  PipelineRunner                                               │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │  │
│  │  │ StageGraph  │  │ GateEngine  │  │ ProgressReporter    │   │  │
│  │  │ (13 stages) │  │ (pass/fail/ │  │ (TUI + sendMessage) │   │  │
│  │  │             │  │  retry)     │  │                     │   │  │
│  │  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘   │  │
│  │         │                 │                    │              │  │
│  │  ┌──────▼─────────────────▼────────────────────▼──────────┐   │  │
│  │  │  AgentSpawner                                          │   │  │
│  │  │  • Uses @agwab/pi-subagent runSubagent() for headless  │   │  │
│  │  │  • Polls getSubagentStatus() for completion            │   │  │
│  │  │  • Reads output from result artifacts                  │   │  │
│  │  │  • Handles timeout, retry, interrupt                   │   │  │
│  │  └──────┬─────────────────────────────────────────────────┘   │  │
│  │         │                                                     │  │
│  │  ┌──────▼─────────────────────────────────────────────────┐   │  │
│  │  │  StateStore (file-based)                               │   │  │
│  │  │  • Writes .pi/super-dev/runs/{runId}/state.json        │   │  │
│  │  │  • Checkpoint per stage for resume                     │   │  │
│  │  │  • Run index for status listing                        │   │  │
│  │  └────────────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  agents/                 (bundled .md files — system prompts)        │
│  skills/super-dev/       (skill definition for LLM guidance)        │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 Key Design Decisions

1. **Tool-based entry**: Register `super_dev_run` as an LLM-callable tool. The LLM calls it when the user requests development work. The tool itself runs the pipeline.

2. **Async execution with polling**: Stages run as headless Pi subagent processes. The tool `execute()` function starts the pipeline, polls for stage completion, evaluates gates, and advances stages — all within a single tool invocation (using `onUpdate` callbacks for progress).

3. **Gate-driven progression**: Between each stage, a gate function evaluates the output. Gates can:
   - `pass` → advance to next stage
   - `fail` → retry with feedback (max N times) or halt
   - `skip` → skip stage (for optional stages like BDD on small fixes)

4. **Resume from checkpoint**: If the tool call is interrupted (Pi session ends), the persisted `state.json` allows the next invocation to resume from the last completed stage.

5. **Bundled `@agwab/pi-subagent`**: Use as a dependency for proven headless execution (same pattern as pi-workflow). This gives us:
   - Battle-tested Pi process lifecycle management
   - Built-in timeout, interrupt, reconcile
   - Artifact storage and session file management
   - Worktree isolation capability for parallel stages

### 4.3 Agent Spawning via `@agwab/pi-subagent`

```typescript
import { runSubagent, getSubagentStatus, waitForSubagent } from "@agwab/pi-subagent/api";

async function executeStage(
  runId: string,
  stage: StageDefinition,
  task: string,
  cwd: string,
): Promise<StageResult> {
  const result = await runSubagent({
    backend: "headless",
    agent: stage.agentName,          // Resolves agent .md file
    task: task,
    systemPrompt: stage.systemPrompt, // Or override from bundled .md
    model: stage.model,
    tools: stage.tools,
    thinking: stage.thinking,
    async: true,
    onComplete: "detach",
    asyncDependency: "needed-before-final",
    workspace: "shared",
    cwd,
    runsDir: `.pi/super-dev/runs/${runId}/stages/${stage.id}`,
    correlationId: `${runId}:${stage.id}`,
    timeoutMs: stage.timeoutMs ?? 300_000,  // 5min default
  });

  // Poll for completion
  const waited = await waitForSubagent({
    cwd,
    runId: result.runId,
    attemptId: result.attemptId,
    runsDir: `.pi/super-dev/runs/${runId}/stages/${stage.id}`,
    timeoutMs: stage.timeoutMs ?? 300_000,
    pollIntervalMs: 2_000,
  });

  return {
    stageId: stage.id,
    status: waited.status,
    output: await readStageOutput(cwd, runId, stage.id, result),
    artifacts: result.artifacts,
    durationMs: result.durationMs,
  };
}
```

---

## 5. What We CAN and CANNOT Do Without pi-workflow

### 5.1 What We CAN Do (Standalone)

| Capability | How |
|-----------|-----|
| Register a tool the LLM calls (`super_dev_run`) | `pi.registerTool(...)` — proven pattern from pi-subagents and @agwab/pi-subagent |
| Register slash commands (`/super-dev`) | `pi.registerCommand(...)` — trivial, used by all extensions |
| Spawn child Pi agents headlessly | `@agwab/pi-subagent` `runSubagent({ backend: "headless" })` |
| Run stages sequentially with gates | Our own JS loop: spawn → poll → evaluate → advance |
| Run stages in parallel | `runSubagent` with `mode: "parallel"` or multiple concurrent calls |
| Persist run state for resume | File-based JSON in `.pi/super-dev/runs/{runId}/` |
| Provide agent `.md` files as system prompts | Bundle in `agents/` directory, pass path or content to spawner |
| Subscribe to lifecycle events | `pi.on("session_start", ...)` for restoring active runs |
| Show progress/status in TUI | `pi.sendMessage(...)` + `ctx.ui.setWidget(...)` + `ctx.ui.notify(...)` |
| Resume interrupted runs | Read persisted `state.json`, skip completed stages, re-spawn current |
| Custom rendering for results | `pi.registerMessageRenderer(...)` |
| Cross-extension communication | `pi.events.emit(...)` / `pi.events.on(...)` |
| Interrupt a running stage | `interruptSubagent({ runId, ... })` |
| Model/thinking level override per stage | Pass `model` and `thinking` to `runSubagent` |
| Worktree isolation for file-mutating stages | `workspace: "worktree"` or `worktree: true` |
| Tool restriction per stage | Pass `tools: [...]` allowlist to `runSubagent` |
| Timeout per stage | `timeoutMs` on `runSubagent` |

### 5.2 What We CANNOT Do (Limitations)

| Limitation | Why | Workaround |
|-----------|-----|-----------|
| No `registerAgent` API | Pi discovers agents from `.md` files in known paths, not via API | Bundle agent `.md` files; pass `systemPrompt` directly or use `agent` name resolution |
| No native workflow DAG in Pi | Pi has no built-in stage/gate/pipeline concept | Build our own pipeline engine in TypeScript |
| No `registerSkill` API | Skills are directory-based, discovered at startup | Declare in `package.json` `"pi": { "skills": [...] }` |
| Cannot inject tools into child agents at runtime | Children discover tools from their own extension loading | Pass `tools` allowlist; pass `extensions` paths for custom tools |
| No shared memory between parent and child | Each Pi process is isolated | File-based IPC: write artifacts, read results |
| Cannot modify parent LLM system prompt dynamically | System prompt set at session start | Use `promptSnippet` and `promptGuidelines` on tool definition |
| No `ctx.getTool()` guarantee | Returns `undefined` if tool not registered | Check existence, provide graceful fallback message |
| No native progress streaming from child | Child output only available after completion | Poll status periodically; use `onUpdate` callback for incremental updates |
| Extension load order not guaranteed | Other extensions may not be loaded yet | Use `session_start` event (fires after all extensions loaded) |

### 5.3 What pi-workflow Provides vs. What We Build

| pi-workflow Feature | Our Replacement |
|--------------------|----------------|
| Workflow spec YAML parsing | TypeScript stage definitions (compile-time type safety) |
| Task dependency resolution (DAG) | Simple sequential + optional parallel grouping |
| Supervisor polling loop | Our own `waitForSubagent` + state machine |
| Dynamic UI approval gates | `ctx.ui.confirm()` for gate approval (when `hasUI`) |
| Run index/history | Our own `index.json` file |
| Resume from failed task | Checkpoint per-stage in `state.json` |
| Multiple workflow specs | Single hardcoded 13-stage pipeline (our use case) |
| Role-based system prompts | Bundled `.md` files per stage agent |
| Web access extensions for children | Pass `extensions` paths to `runSubagent` |

---

## 6. How to Build the Self-Contained 13-Stage Pipeline Runner

### 6.1 Pipeline Definition

```typescript
// src/engine/stages.ts
export interface StageDefinition {
  id: string;
  name: string;
  description: string;
  agentName: string;            // Maps to agents/{name}.md
  tools?: string[];             // Tool allowlist for this stage
  thinking?: ThinkingLevel;     // Reasoning level
  model?: string;               // Model override (or inherit from run config)
  timeoutMs?: number;           // Per-stage timeout
  optional?: boolean;           // Can be skipped by gate
  parallel?: string[];          // Stages that can run in parallel with this one
  gate: GateDefinition;         // How to evaluate stage output
  inputFrom?: string[];         // Stage IDs whose output feeds this stage's task
}

export interface GateDefinition {
  type: "auto" | "manual" | "llm";
  maxRetries?: number;
  criteria?: string;            // For LLM gate: evaluation prompt
  requiredFields?: string[];    // For auto gate: check output contains these
}

export const PIPELINE_STAGES: StageDefinition[] = [
  { id: "classify",       name: "Task Classification",   agentName: "classifier",       gate: { type: "auto" }, ... },
  { id: "requirements",   name: "Requirements",          agentName: "requirements-clarifier", gate: { type: "auto" }, ... },
  { id: "bdd",            name: "BDD Scenarios",         agentName: "bdd-scenario-writer",    gate: { type: "auto" }, optional: true, ... },
  { id: "research",       name: "Research",              agentName: "research-agent",         gate: { type: "auto" }, ... },
  { id: "assessment",     name: "Code Assessment",       agentName: "code-assessor",          gate: { type: "auto" }, ... },
  { id: "design",         name: "Architecture Design",   agentName: "architecture-designer",  gate: { type: "llm" }, ... },
  { id: "spec",           name: "Specification",         agentName: "spec-writer",            gate: { type: "auto" }, ... },
  { id: "spec-review",    name: "Spec Review",           agentName: "spec-reviewer",          gate: { type: "llm", maxRetries: 2 }, ... },
  { id: "implement",      name: "Implementation (TDD)", agentName: "tdd-guide",              gate: { type: "auto" }, ... },
  { id: "code-review",    name: "Code Review",           agentName: "code-reviewer",          gate: { type: "llm", maxRetries: 2 }, ... },
  { id: "docs",           name: "Documentation",         agentName: "doc-updater",            gate: { type: "auto" }, ... },
  { id: "cleanup",        name: "Cleanup",               agentName: "refactor-cleaner",       gate: { type: "auto" }, ... },
  { id: "merge",          name: "Merge Preparation",     agentName: "handoff-writer",         gate: { type: "auto" }, ... },
];
```

### 6.2 Pipeline Runner (State Machine)

```typescript
// src/engine/runner.ts
export class PipelineRunner {
  private state: PipelineState;
  private store: StateStore;
  private spawner: AgentSpawner;

  async run(task: string, options: RunOptions, signal: AbortSignal): Promise<PipelineResult> {
    // 1. Initialize or resume
    this.state = await this.store.loadOrCreate(options.runId, task, options);

    // 2. Walk stages from checkpoint
    for (const stage of PIPELINE_STAGES) {
      if (signal.aborted) break;
      if (this.state.completedStages.includes(stage.id)) continue;
      if (stage.optional && this.shouldSkip(stage)) continue;

      // 3. Build task prompt from prior stage outputs
      const stageTask = this.buildStageTask(stage, task);

      // 4. Execute stage (spawn headless Pi agent)
      this.state.currentStage = stage.id;
      await this.store.save(this.state);
      const result = await this.spawner.execute(this.state.runId, stage, stageTask);

      // 5. Evaluate gate
      const verdict = await this.evaluateGate(stage, result);
      if (verdict === "retry" && (result.retryCount ?? 0) < (stage.gate.maxRetries ?? 1)) {
        // Re-run with feedback
        continue;
      }
      if (verdict === "fail") {
        this.state.status = "failed";
        this.state.failedStage = stage.id;
        await this.store.save(this.state);
        return { status: "failed", failedAt: stage.id, output: result.output };
      }

      // 6. Mark complete, save output
      this.state.completedStages.push(stage.id);
      this.state.stageOutputs[stage.id] = result.output;
      await this.store.save(this.state);
    }

    this.state.status = "completed";
    await this.store.save(this.state);
    return { status: "completed", outputs: this.state.stageOutputs };
  }
}
```

### 6.3 Gate Engine

```typescript
// src/engine/gate.ts
export async function evaluateGate(
  stage: StageDefinition,
  result: StageResult,
  spawner: AgentSpawner,
): Promise<"pass" | "fail" | "retry"> {
  if (result.status !== "completed") return "fail";

  switch (stage.gate.type) {
    case "auto":
      // Check output is non-empty and contains required fields
      if (!result.output?.trim()) return "retry";
      if (stage.gate.requiredFields) {
        const missing = stage.gate.requiredFields.filter(f => !result.output.includes(f));
        if (missing.length > 0) return "retry";
      }
      return "pass";

    case "llm":
      // Spawn a lightweight reviewer agent to evaluate
      const verdict = await spawner.evaluateWithLLM(stage, result);
      return verdict;  // "pass" | "fail" | "retry"

    case "manual":
      // Would use ctx.ui.confirm() — but we're headless here
      return "pass";  // Default pass for now
  }
}
```

### 6.4 Extension Entry Point

```typescript
// src/extension.ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PipelineRunner } from "./engine/runner.ts";
import { StateStore } from "./state/store.ts";
import { AgentSpawner } from "./engine/spawner.ts";

export default function activate(pi: ExtensionAPI): void {
  const store = new StateStore();
  const spawner = new AgentSpawner();

  // Register the orchestration tool
  pi.registerTool({
    name: "super_dev_run",
    label: "Super Dev Pipeline",
    description: "Run the 13-stage super-dev development pipeline...",
    promptSnippet: "Start or resume the super-dev pipeline for a development task.",
    promptGuidelines: [
      "Use super_dev_run when the user asks to implement a feature, fix a bug, or refactor code using the full pipeline.",
      "Pass the user's full task description as the 'task' parameter.",
      "Do not call super_dev_run for simple questions or one-line fixes.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Full task description" }),
      action: Type.Optional(Type.Union([
        Type.Literal("run"),
        Type.Literal("status"),
        Type.Literal("resume"),
      ])),
      runId: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { task, action = "run", runId } = params as any;
      const runner = new PipelineRunner(store, spawner, ctx);

      if (action === "status") {
        const state = await store.getStatus(ctx.cwd, runId);
        return { content: [{ type: "text", text: formatStatus(state) }], details: state };
      }

      if (action === "resume") {
        const result = await runner.resume(runId, signal, onUpdate);
        return { content: [{ type: "text", text: formatResult(result) }], details: result };
      }

      const result = await runner.run(task, { cwd: ctx.cwd, model: ctx.model }, signal, onUpdate);
      return { content: [{ type: "text", text: formatResult(result) }], details: result };
    },
  });

  // Register slash command as convenience
  pi.registerCommand("super-dev", {
    description: "Run the 13-stage super-dev pipeline",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.output("Usage: /super-dev <task description>");
        return;
      }
      // Trigger the tool via the LLM's next turn
      pi.sendMessage({
        content: `Starting super-dev pipeline for: ${args.trim()}\n\nUse the super_dev_run tool to execute this.`,
        display: true,
      });
    },
  });

  // Restore active runs on session start
  pi.on("session_start", async (_event, ctx) => {
    const activeRuns = await store.getActiveRuns(ctx.cwd);
    if (activeRuns.length > 0) {
      pi.sendMessage({
        content: `Active super-dev runs:\n${activeRuns.map(r => `- ${r.runId}: ${r.currentStage} (${r.status})`).join("\n")}\n\nUse super_dev_run({ action: "resume", runId: "..." }) to continue.`,
        display: true,
      });
    }
  });
}
```

---

## 7. Implementation Plan for the Standalone Engine

### Phase 1: Foundation (1-2 days)
1. Add `@agwab/pi-subagent` as bundled dependency
2. Create `src/engine/spawner.ts` — wrapper around `runSubagent` + `waitForSubagent`
3. Create `src/state/store.ts` — file-based state persistence
4. Create `src/state/types.ts` — `PipelineState`, `StageResult`, `RunConfig` types
5. Verify basic spawn + poll loop works with a single test agent

### Phase 2: Pipeline Engine (2-3 days)
1. Create `src/engine/stages.ts` — 13-stage definitions with gate configs
2. Create `src/engine/runner.ts` — state machine that walks stages
3. Create `src/engine/gate.ts` — gate evaluation (auto + LLM-based)
4. Create `src/engine/task-builder.ts` — composes stage task prompts from prior outputs
5. Test: run a 3-stage subset end-to-end

### Phase 3: Extension Integration (1-2 days)
1. Rewrite `src/extension.ts` — register `super_dev_run` tool + `/super-dev` command
2. Add `onUpdate` progress reporting during pipeline execution
3. Add session_start handler for run restoration
4. Add `promptGuidelines` so the LLM knows when to use the tool
5. Test: full pipeline triggered by LLM tool call

### Phase 4: Agent Definitions (2-3 days)
1. Write/refine 13 agent `.md` files in `agents/` directory
2. Each agent gets: system prompt, tool allowlist, thinking level, timeout
3. Define gate criteria for each stage
4. Test: full 13-stage pipeline on a real task

### Phase 5: Polish (1-2 days)
1. Resume support — verify interrupted runs restart correctly
2. Error handling — stage failures, timeout recovery, max retries
3. TUI progress widget (optional)
4. Documentation

### Dependency Graph

```
Phase 1 (Foundation)
    │
    ▼
Phase 2 (Engine) ──────► Phase 4 (Agents)
    │                          │
    ▼                          ▼
Phase 3 (Extension) ──► Phase 5 (Polish)
```

---

## 8. Code Examples from Real Extensions

### 8.1 Registering a Tool with Full Features (from `@agwab/pi-subagent/src/index.ts`)

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function registerSubagentEngine(pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Subagent engine. Executes headless/tmux/inline workers...",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ minLength: 1 })),
      task: Type.Optional(Type.String({ minLength: 1 })),
      backend: Type.Optional(Type.Union([
        Type.Literal("headless"),
        Type.Literal("inline"),
        Type.Literal("tmux"),
      ])),
      async: Type.Optional(Type.Boolean()),
      // ...more params
    }),
    renderCall(args, theme) {
      const title = theme.fg("toolTitle", theme.bold("subagent"));
      return new SingleLineComponent(`${title} ${theme.fg("muted", "...")}`);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      // ... execution logic
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { result },
        isError: false,
      };
    },
  });
}
```

### 8.2 Registering a Command (from `pi-simplify`)

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerCommand("simplify", {
    description: "Review recently changed files for clarity, consistency, and maintainability",
    handler: (args, ctx) => handleSimplifyCommand(args, ctx, pi),
  });
}
```

### 8.3 Listening to Lifecycle Events (from `attyx-status.ts`)

```typescript
export default function (pi) {
  pi.on("session_start", async () => emit("idle"));
  pi.on("agent_start", async () => emit("working"));
  pi.on("tool_call", async () => emit("working"));
  pi.on("agent_end", async () => emit("idle"));
  pi.on("message_end", async (event, ctx) => {
    if (event?.message?.role === "assistant") {
      const model = ctx?.model?.id;
      const cu = ctx?.getContextUsage?.();
      // cu.tokens, cu.contextWindow
    }
  });
}
```

### 8.4 Using ctx for Notifications (from `orca-agent-status.ts`)

```typescript
export default function (pi): void {
  pi.on("before_agent_start", async (event) => {
    // event.prompt available here
  });
  pi.on("tool_execution_start", async (event) => {
    // event.toolName, event.args available
  });
  pi.on("session_shutdown", async () => {
    // Cleanup
  });
}
```

### 8.5 pi-workflow Spawning via @agwab/pi-subagent (from `subagent-backend.ts`)

```typescript
const subagentApiSpecifier = "@agwab/pi-subagent/api";
const api = await import(subagentApiSpecifier);

const launched = await api.runSubagent({
  cwd: task.cwd,
  backend: "headless",
  task: compiledTask.compiledPrompt,
  systemPrompt: buildSystemPrompt(compiledTask),
  model: compiledTask.runtime.model,
  thinking: compiledTask.runtime.thinking,
  tools: compiledTask.runtime.tools,
  async: true,
  onComplete: "detach",
  asyncDependency: "needed-before-final",
  workspace: "shared",
  worktreePolicy: "never",
  timeoutMs: compiledTask.runtime.maxRuntimeMs,
  runsDir: `.pi/workflow-subagents/${run.runId}/${task.taskId}`,
  correlationId: `${run.runId}:${task.taskId}`,
  extensions: [...taskExtensions],
});
// Returns: { runId, attemptId, status, artifacts, cwd }

// Later, poll status:
await api.reconcileSubagentRun({ cwd, runsDir, runId: handle.runId });
const snapshot = await api.getSubagentStatus({
  cwd: handle.cwd,
  runsDir: handle.runsDir,
  runId: handle.runId,
  attemptId: handle.attemptId,
});
// snapshot.status: "running" | "completed" | "failed" | "cancelled" | "pending"
```

### 8.6 pi-intercom Extension Registration (from `pi-intercom/index.ts`)

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function intercomExtension(pi: ExtensionAPI) {
  // Register tool
  pi.registerTool({
    name: "contact_supervisor",
    label: "Contact Supervisor",
    description: "Send a message to the orchestrator/supervisor session...",
    parameters: Type.Object({
      reason: Type.String(),
      message: Type.String(),
    }),
    async execute(id, params, signal, onUpdate, ctx) {
      // ... send via intercom broker
    },
  });

  // Register slash command
  pi.registerCommand("intercom", {
    description: "Open the intercom session list",
    async handler(args, ctx) {
      // ... show TUI overlay
    },
  });

  // Listen for events from other extensions
  pi.events.on("subagent:control-intercom", (payload) => {
    // Handle cross-extension communication
  });
}
```

---

## 9. Package.json Configuration

```json
{
  "name": "@jenningsloy318/pi-super-dev",
  "version": "0.2.0",
  "description": "Self-contained 13-stage development pipeline for Pi Coding Agent.",
  "type": "module",
  "license": "MIT",
  "keywords": ["pi-package", "pi-extension"],
  "exports": {
    ".": "./dist/index.js",
    "./extension": "./src/extension.ts",
    "./package.json": "./package.json"
  },
  "main": "./dist/index.js",
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./skills/super-dev"]
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@agwab/pi-subagent": "^0.3.6",
    "typebox": "^1.1.24"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "bundleDependencies": ["@agwab/pi-subagent"],
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typescript": "^5.4",
    "vitest": "^3.0"
  },
  "engines": {
    "node": ">=22.19.0"
  }
}
```

---

## 10. Summary

**The recommended approach is to build a completely self-contained orchestration engine** that:

1. Registers `super_dev_run` as an LLM-callable tool
2. Bundles `@agwab/pi-subagent` for headless Pi process spawning
3. Implements its own pipeline state machine (13 stages with gates)
4. Persists state to `.pi/super-dev/runs/` for resume
5. Bundles agent `.md` files for each stage's system prompt
6. Has zero runtime dependency on `@agwab/pi-workflow`

This is architecturally identical to how pi-workflow works (it also bundles `@agwab/pi-subagent` and implements its own orchestration on top), but our engine is purpose-built for the super-dev pipeline rather than being a generic workflow runner.
