# 060 — Communication Mechanism (inter-agent control transfer)

Status: reference — external research (2026-09-15). Saved from a parallel session (draft), then grounded against the OpenAI Agents SDK orchestration guide + handoffs guide (fetched verbatim).

**Original parallel-session notes (kept verbatim):**
- shared session state: one agent writes a value to the shared session.state dictionary, the next agent in the sequence reads that value from the state to use in its prompt or logic
- LLM-driven delegation (agent transfer) / orchestrator: the parent (delegator) agent uses its LLM's reasoning ability to pair the user's intent with sub-agents, then it generates a `transfer_to_agent` call to hand off control
- explicit invocation (agent as a tool): the specialist agent is wrapped in an `agentTool` and added to the manager agent's tools list

| Feature | Agent-as-a-Tool | Sub-Agent |
|---|---|---|
| Who stays in control? | Main agent (Agent A) | Sub-agent (Agent B) takes over |
| Who talks to the user next? | Main agent | Sub-agent |
| What is it used for? | Calling helper agents for single tasks | Handing off full control (e.g. different domain, different task owner) |
| Analogy | Asking a friend to fetch info and report back | Letting your friend take over the meeting |

---

## Research grounding (OpenAI Agents SDK, 2026-09-15)

### 1. The two orchestration patterns — "who owns the answer" is the design axis

The SDK says two orchestration patterns "come up most often" (not an exhaustive claim), and the deciding question is **who owns the final user-facing answer at each branch**:

| Pattern | How it works | Best when |
|---|---|---|
| **Agents as tools** | Manager agent keeps control of the conversation and calls specialist agents via `agent.asTool()`. Manager decides which tools to call and how to present the final response. | One agent should own the final answer; combine outputs from multiple specialists; enforce **shared guardrails in one place**. |
| **Handoffs** | A triage agent routes the conversation to a specialist, and that specialist **becomes the active agent** for the next part. The handoff preserves conversation context while narrowing the active instructions to the specialist. | Routing itself is part of the workflow; the selected specialist should own the next part of the conversation. |

They **compose**: a triage agent can hand off to a specialist, and that specialist can still use other agents as tools for bounded subtasks.

### 2. Handoff mechanics — the details that matter

- Handoffs are **represented as tools to the LLM**. A handoff to `Refund Agent` produces a tool named `transfer_to_refund_agent`. `handoff_description` (when set) is appended to the default tool description — a cheap way to hint *when* the model should pick that handoff without writing a full handoff object.
- **`on_handoff` callback** fires when the handoff is invoked — useful for kicking off data fetching as soon as you know the handoff is happening. This is *preparation*, not authorization.
- **`input_type` is metadata, not state.** It is the schema for the handoff tool-call arguments (`reason`, `language`, `priority`, `summary`) — model-decided at handoff time. It does NOT replace the next agent's main input, does NOT choose a different destination, and is separate from run context. Use `RunContextWrapper.context` for application state and dependencies you already have locally; use `input_filter` / `nest_handoff_history` / `handoff_history_mapper` to change what history the next agent sees.
- **`is_enabled` is evaluated before the model returns handoff arguments**, so it cannot authorize values inside an argument-bearing handoff. When authorization depends on parsed fields, do the check **at the start of `on_handoff`, before any side effect**; raise on failure — the SDK continues the transfer only after `on_handoff` returns successfully. **Tool input guardrails apply to function tools, not handoffs.**
- **Guardrail scope is asymmetric:** input guardrails apply only to the **first agent in the chain**; output guardrails only to the agent producing the **final output**. Use **tool guardrails** when you need checks around each custom function-tool call inside the workflow.
- **Handoffs stay within a single run.**
- `nest_handoff_history` (opt-in beta, disabled by default) compacts summarizable history into ordered `<CONVERSATION HISTORY>` segments while preserving lossless message items in their original positions; later handoffs flatten earlier segments before rebuilding the transcript. Sessions track exact message occurrences moved so they are not appended twice.

### 3. Orchestrating via code — the deterministic alternative

Two ways to orchestrate: **LLM-driven** (agent plans with tools + handoffs) and **code-driven** (deterministic, predictable in speed/cost/performance — the SDK's word is "performance"). Code patterns:
- **Structured outputs for routing** — classify the task into categories via structured output, then pick the next agent from the category. (Deterministic dispatch beats LLM transfer when the categories are enumerable.)
- **Chaining** — transform one agent's output into the next's input (research → outline → draft → critique → improve).
- **Evaluator + `while` loop** — run the task agent in a loop with an evaluator agent providing feedback until the output passes criteria. ← *this is the convergence loop*
- **`Promise.all` parallel** — for tasks that don't depend on each other.

The SDK's own advice for LLM-driven orchestration — five tactics, two of which the earlier draft dropped: (1) invest in good prompts, (2) monitor and iterate on where it goes wrong, (3) allow the agent to introspect and improve, (4) have specialized agents rather than one generalist, and (5) invest in evals.

### 4. Delegation vs handoff — topology and session (from multi-agent survey material)

| | Delegation (`sub_agents`) | Handoffs (`handoffs`) |
|---|---|---|
| Topology | Hierarchical (parent → child → parent) | Peer-to-peer graph (A → B → C → A) |
| Session | Child runs in the parent's context scope, returns a value | Control transfers; the callee becomes the active agent |

### 5. What super-dev already has, and what the taxonomy clarifies

Grounding against our own machinery (`src/nodes.ts`, `src/team/messages.ts`, `src/workflow.ts`):

- **Our default is code orchestration**, not LLM orchestration: the node algebra (`sequence`/`parallel`/`branch`/`choose`/`loop`/`retry`/`gate`/`map`/`tryCatch`) is the deterministic control flow; `choose` is our structured-output routing; `parallel` is our `Promise.all`; convergence loops are our evaluator+while.
- **We use delegation (agents-as-tools), not handoffs.** Reviewer/writer/judge agents are specialists that return structured results into `state`; the pipeline always owns the answer and enforces shared guardrails (boundary quarantine, concurrency writers, phase gates) in one place. There is no `transfer_to_*` — control never leaves the pipeline. This is the SDK's "agents as tools … enforce shared guardrails in one place" case, chosen deliberately.
- **Our `messages.jsonl` is the WHO channel** (messages.ts's own framing: role-to-role bus — sender/receiver/subject/inReplyTo, double-written to the event ledger). The WHAT-channel analogue is pipeline state + `.knowledge.json` (`063` for location): the declarative extraction channel — the pipeline extracts fields into prompts; agents never read the file.
- **The guardrail-scope asymmetry is a real hazard to remember:** if a reviewer is reached via a chain, input-side guardrails only hold for the first agent in the chain. Our equivalent — boundary/permission enforcement — is applied per task node, which is the tool-guardrail shape, not the handoff shape.

---

## Sources

1. OpenAI Agents SDK (JS) — *Agent Orchestration*: https://openai.github.io/openai-agents-js/guides/multi-agent/
2. OpenAI Agents SDK (Python) — *Handoffs*: https://openai.github.io/openai-agents-python/handoffs/
3. OpenAI Agents SDK (Python) — *Multi-agent*: https://openai.github.io/openai-agents-python/multi_agent/
4. OpenAI API docs — *Orchestration*: https://developers.openai.com/api/docs/guides/agents/orchestration.md
5. Microsoft ISE — *A2A context passing in multi-agent systems*: https://devblogs.microsoft.com/ise/a2a-context-passing-multi-agent-systems/
6. DeepWiki — *Manager pattern vs handoffs* (LangGraph): https://deepwiki.com/openai/openai-agents-python/5.2-manager-pattern-vs-handoffs

---

## 6. Feature ownership & decoupling (2026-09-15)

This doc is a **REFERENCE** — it owns NO implementable feature.

- **Does NOT own:** where state files live (`.knowledge.json`, `messages.jsonl`
  as files on disk). Storage location is `063`'s feature family. This doc owns
  the **semantics** of `messages.jsonl` as the role-to-role bus (sender /
  receiver / subject / `inReplyTo` threading, double-write to the event ledger)
  and of `.knowledge.json` as the declarative extraction channel — both are
  descriptions of existing behavior, not proposed changes.
- **Does NOT own:** the node algebra or the agents-as-tools choice. §5
  documents what the code already does; it is not a delta.
- **Supplies rationale for (candidate future spec):** the **guardrail-scope
  asymmetry audit** (§2) — verifying that no reviewer reachable through a chain
  escapes boundary enforcement the way an SDK handoff chain would. This is a
  test-only wave; it depends on nothing and can ship after 063's S2.

See INDEX.md § Feature ownership for the full cross-doc inventory and the
sequential implementation order.

### Grill round 2 enrichment (2026-09-15, glm-5.3 — verdict READY)

The audit candidate above should be **re-scoped** by what the grill verified in
code: there are no handoff chains in this harness (every specialist call is a
one-shot `context: "fresh"` delegation returning a parsed value), so the SDK's
first-agent-only guardrail hazard **cannot arise via chain position**. The two
real residual escapes are:

1. **Default-write** — `accessMode` defaults to `"write"` (workflow.ts ~:688).
   Any reviewer-family dispatch that omits `accessMode: "source-read-only"`
   escapes boundary enforcement entirely. The audit's primary enumeration:
   every reviewer dispatch site vs. the flag (code/adversarial/tests
   reviewers, red-boundary-classifier, api/ui testers were all verified set
   in stages/verify.ts — the audit is to keep it that way as sites are added).
2. **Fail-open degradation** — when `git status` is unavailable, boundary
   enforcement silently degrades to the prompt-only advisory (workflow.ts
   ~:762 pre-call, ~:772–776 post-check: "relying on tool restrictions").
   The audit should decide whether that degradation warrants a loud P10
   notice rather than silence.

Nested delegation (a child spawning its own subagents) still falls inside the
outer before/after git diff — covered by construction; worth a pinning test,
not a redesign.
