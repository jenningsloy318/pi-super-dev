# Research: SKILL.md vs Execution Router

## Question

Should `@jenningsloy318/pi-super-dev` include a `skills/super-dev/SKILL.md` (explicit skill trigger), or should it rely entirely on pi-workflow's bundled `execution-router` skill to dispatch user requests to the workflow?

---

## Findings

### 1. Does the execution-router automatically discover all registered workflows?

**Yes, but only indirectly.** The execution-router does not discover workflows itself. It is a *decision skill* that helps the LLM choose an execution architecture (single-agent vs workflow vs subagent). It references bundled workflows by a hardcoded table in its SKILL.md:

```
| Workflow | Use when | Do not use when |
| deep-research | Broad source gathering... | Small factual answers... |
| deep-review | General code-review... | Direct bug fixing... |
```

The router does NOT enumerate project-local or plugin-installed workflows. It says "discover existing workflows when the user asks to choose a route or when project-local workflows may matter" but relies on the LLM calling `workflow_list` to discover them.

The `workflow_list` LLM tool (registered by the extension) discovers workflows by scanning:
1. `<cwd>/.pi/workflows/`
2. `<cwd>/workflows/`
3. bundled package `workflows/`
4. `~/.pi/agent/workflows/`

It reads each `spec.json` and exposes `name`, `description`, `agent`, and `readOnly`. It does NOT expose trigger keywords, exclusion patterns, or complex routing logic.

**Evidence:** `src/extension.ts` lines 146-174 (workflow_list tool), `src/workflow-specs.ts` lines 106-130 (listWorkflows function), execution-router SKILL.md lines 83-99 (hardcoded bundled workflow table).

### 2. Can a custom SKILL.md improve trigger accuracy beyond what the router provides?

**Yes, significantly.** The execution-router provides no per-workflow trigger customization. It uses only `name` and `description` from spec.json. A SKILL.md adds:

- **Explicit trigger keywords** ("implement", "build", "fix bug", "refactor", "add feature")
- **Explicit exclusion rules** ("Do NOT trigger on: simple questions, file searches, one-off commands")
- **Action instructions** (tells the LLM exactly what tool call to make: `workflow_run({ workflow: "super-dev", task: "..." })`)
- **Context preservation rules** ("Preserve the user's language, file references, and constraints")

Without SKILL.md, the LLM must:
1. Read the user's request
2. Decide it might need a workflow (vague heuristic)
3. Call `workflow_list` to discover available workflows
4. Match by name/description alone
5. Figure out what `task` parameter to pass

With SKILL.md, the LLM:
1. Reads the skill description in the system prompt (always loaded)
2. Recognizes trigger keywords directly
3. Knows the exact tool call format

**Evidence:** The existing super-dev-plugin has a detailed SKILL.md with triggers/exclusions. The workflow spec.json description is a single line with no routing intelligence.

### 3. Do the built-in workflows (deep-research, deep-review) have their own skills?

**No.** The bundled workflows (deep-research, deep-review, impact-review, spec-review) do NOT have their own SKILL.md files. The only skills in pi-workflow are:
- `skills/execution-router/SKILL.md` — generic routing decision skill
- `skills/workflow-guide/SKILL.md` — workflow authoring guidance

The bundled workflows rely on:
1. The execution-router's hardcoded table mentioning them
2. The `workflow_run` tool's `promptGuidelines` which say "Use when the user explicitly asks to run, start, execute, or use a pi-workflow by name"
3. The `workflow_list` tool for discovery

**Critical difference:** Bundled workflows are simple read-only review/research tools. They respond to explicit requests like "use deep-review to review my diff." They do NOT need proactive trigger detection because they don't intercept general development requests.

Super-dev is fundamentally different — it needs to intercept broad development intents ("implement this", "add a feature") that the user would NOT phrase as "use the super-dev workflow." This is a key distinction.

**Evidence:** `find skills/ -name SKILL.md` returns only execution-router and workflow-guide. Package.json `pi.skills` array lists only those two.

### 4. Is there precedent for plugin skills being redundant with the router?

**No precedent exists because no workflow plugin ships a SKILL.md in pi-workflow itself.** The execution-router is designed for meta-level architectural decisions, NOT for triggering specific workflows from user intent. Its scoring system (single-agent sufficiency, workflow fit, multi-agent benefit/penalty) is about whether *any* workflow approach is warranted, not which specific workflow to run.

The super-dev-plugin (the existing Claude Code plugin) ships 28+ SKILL.md files (one per sub-capability). This is the established pattern for complex orchestration plugins.

### 5. What happens if BOTH exist — a plugin SKILL.md AND the execution-router?

**They serve different purposes and do not conflict:**

- **SKILL.md** → Loaded into the LLM's system prompt. Acts as a direct intent matcher. When the user says "implement this feature", the LLM reads the skill description and knows to call `workflow_run`.
- **execution-router** → A separate skill invoked when the user asks "should I use a workflow for this?" or when the LLM is uncertain about execution architecture. It is advisory, not triggering.

They are complementary, not competing. The execution-router even has a guideline: "Skip for trivial one-step edits, direct factual answers, or cases where the user explicitly chose the execution mode and only wants implementation."

### 6. What does the execution-router do for complex exclusion patterns?

**Nothing.** The execution-router has no mechanism for per-workflow exclusion patterns. It operates at the architectural level ("is workflow appropriate?"), not the workflow-selection level ("which workflow?"). It cannot express "Do NOT trigger on: simple questions, file searches, one-off commands, code explanations, quick edits" for a specific workflow.

The `workflow_run` tool's `promptGuidelines` include only generic rules:
- "Do not use workflow_run for ordinary research, review, or coding requests unless the user asks to use a workflow."
- "Do not call workflow_run unless both an exact workflow name/path and a concrete task are known"

These are defensive (prevent false triggers) but provide no positive matching for when TO trigger super-dev.

### 7. Would removing SKILL.md break discoverability?

**Yes.** Without SKILL.md, the workflow would only be discoverable through:
1. `workflow_list` → Returns name "super-dev" and description. No trigger keywords, no exclusions, no action template.
2. Manual `/workflow run super-dev "..."` commands by users who already know it exists.

The LLM would never proactively suggest using super-dev for a request like "implement authentication for my app" because:
- The `workflow_run` tool's guidelines explicitly say "Do not use workflow_run for ordinary... coding requests unless the user asks to use a workflow"
- The spec.json description mentions "requirements, BDD, research, design, TDD implementation, code review" but does not establish trigger conditions

---

## Comparison Matrix

| Dimension | With SKILL.md | Without SKILL.md (router only) |
|---|---|---|
| **Trigger accuracy** | High — explicit keywords match user intent | Low — relies on user naming the workflow |
| **False positive prevention** | Explicit exclusion rules | None workflow-specific |
| **Discovery** | System prompt + workflow_list | workflow_list only |
| **Action clarity** | Exact tool call template provided | LLM must figure out parameters |
| **Maintenance cost** | One small file (~25 lines) | None |
| **Conflict risk** | None — complementary to router | N/A |
| **Precedent** | Matches super-dev-plugin pattern (28 skills) | Matches bundled passive workflows (0 skills) |
| **User experience** | "implement this" → auto-triggers | "use super-dev workflow to implement this" → works |

---

## Recommendation: KEEP SKILL.md

**Justification:**

1. **Super-dev is an active orchestrator, not a passive tool.** Unlike deep-research/deep-review (which users invoke by name), super-dev must intercept broad development intents. Without SKILL.md, users must explicitly request the workflow by name.

2. **The execution-router cannot replace SKILL.md.** The router is an architectural advisor, not a workflow trigger. It doesn't know about super-dev's triggers or exclusions. It would need to be extended to support per-plugin routing metadata — which is exactly what SKILL.md already provides.

3. **Zero conflict.** SKILL.md and the execution-router operate at different levels. The skill catches direct intent ("implement this"), the router handles meta-questions ("should I use a workflow?").

4. **Minimal cost, high value.** The current SKILL.md is 25 lines. It provides trigger keywords, exclusion rules, and the exact tool call. Removing it saves nothing and loses proactive triggering.

5. **Consistent with the upstream plugin pattern.** The super-dev-plugin ships 28 SKILL.md files. Maintaining one in the workflow variant follows the same architecture.

---

## Changes Needed (keeping SKILL.md)

The current SKILL.md at `skills/super-dev/SKILL.md` is well-structured and correct. Minor improvements:

1. **Add the `super-dev:super-dev-workflow` description format** if the pi package system uses qualified names for disambiguation.
2. **Ensure package.json `pi.skills`** references the skill directory (already done: `"./skills/super-dev"`).
3. **No changes needed to the execution-router** — it handles meta-routing independently.

---

## If Removing (not recommended)

If SKILL.md were removed:
1. Remove `"./skills/super-dev"` from package.json `pi.skills` array.
2. Delete `skills/super-dev/` directory.
3. Accept that users must explicitly invoke `/workflow run super-dev "..."` or know the workflow name.
4. The workflow would still be discoverable via `workflow_list` by name/description.
5. Proactive triggering on development requests would be lost entirely.
