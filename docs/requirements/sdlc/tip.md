1. Tests verify the deterministic parts of the system: a function given this input produces that output. Evaluations, or evals, verify the parts that are not deterministic: did the agent take the right trajectory of steps, choose the right tools, and produce a final response that meets the quality bar. Tests are checked by code; evals are checked by labelled datasets, scoring rubrics, and LM judges. Without both, the practice is always vibe coding, regardless of how sophisticated the prompts are.
2. Context engineering: the real skill
Developers must consider six primary types of context:
• Instructions: The agent's core role, goals, and operational boundaries.
• Knowledge: Retrieved documents, architectural diagrams, and domain-specific data.
• Memory: Short-term session logs (what just happened) and long-term persistent state
(what the project is).
• Examples: Few-shot behavioral demonstrations and codebase reference patterns.
• Tools: The precise definitions of the APIs, scripts, and external services the agent
can invoke.
• Guardrails: Hard constraints, formatting rules, and safety validations.
3. Testing and quality assurance
Testing AI-generated code requires evaluating not just what the agent produced, but how
it got there. Output evaluation checks the final artifact: does the code compile, do the tests
pass? Trajectory evaluation checks the full sequence of tool calls and intermediate reasoning.
Both are necessary because a fluent output that skipped its verification steps is a more
dangerous failure than one with a visible error.
AI also transforms test generation itself. Agents can produce test cases, including edge
cases and property-based tests, that humans might not think of. More importantly, tests and
evals become the primary mechanism for communicating intent to AI agents: a well-written
eval suite tells the AI what "correct" means and provides an automated way to verify it.
These practices are most effective when wired into a continuous quality flywheel: evaluate
against a benchmark suite, diagnose failures by clustering root causes, optimize the prompts
or tools that caused them, verify fixes against a regression suite, and monitor production
traffic for new failure modes. Each cycle compounds.
4. harness
The model is one input into a
running agent. Everything else, the prompts, the tools, the context policies, the hooks, the
sandboxes, the sub-agents, the observability, is the harness: the scaffolding wrapped around
the model that lets it actually finish something.¹¹
A raw model is not an agent. It becomes one once a harness gives it state, tool execution,
feedback loops, and enforceable constraints. The behaviour developers experience when
working with Claude Code, Cursor, Codex, Antigravity, Aider, or Cline is dominated by what
the harness does, not just by which model is underneath.
What's in the harness
Concretely, a harness includes:
• Instructions and Rule Files: The text that defines who the agent is, what it cares about,
and what it is forbidden from doing. This includes AGENTS.md, CLAUDE.md, GEMINI.md,
skill files, and sub-agent prompts.
• Tools: The functions, MCP servers, and APIs the agent can call, plus the prose around
them that tells the model when and how to call them.
• Sandboxes and execution environments: Where the agent's code actually runs, what it
has access to, what it cannot reach.
• Orchestration logic: Sub-agent spawning, model routing, hand-offs between specialists,
and the rules that govern when each one fires.
• Guardrails or Hooks: Deterministic code that runs at specific lifecycle points: before a
tool call, after a file edit, before a commit. Hooks are the place for things the agent should
never forget but often does.
• Observability: Logs, traces, evaluations, cost and latency metering. Without
observability, there is no way to tell whether the agent is doing well or quietly drifting.
5. The orchestrator: async, multi-agent delegation
The orchestrator mode requires a different skill set. Instead of deep expertise in syntax and
language idioms, it demands strong skills in:
• Specification: Defining tasks precisely enough that an agent can execute them
without ambiguity
Decomposition: Breaking large tasks into appropriately sized units for agent execution
• Evaluation: Quickly assessing whether agent output meets quality standards
• System design: Designing the constraints, tests, and feedback loops that keep
agents productive
6. dynamic context t
advanced agentic engineering relies on dynamic context through
the use of "skills" or tool calling (such as Model Context Protocol servers) which we cover in
detail in day-3 paper.
7. Intelligent Model Routing 
. It uses large, advanced models for highly
complex tasks (Requirements, Architecture, and initial Implementation) but automatically
routes deterministic, lower-complexity tasks (Test Generation, Code Review, and CI/CD
monitoring) to smaller, faster, and significantly cheaper models. By orchestrating a multimodel ecosystem, engineering teams can maintain peak output quality while systematically
driving down the operational token cost.
8. Conclusion: Intent as the new Interface
Developers are already spending more time describing what they want than specifying how
to build it. The SDLC is already being compressed, restructured, and reimagined around AI
capabilities. The question is not whether this transformation will happen, but how effectively
individual developers, teams, and organizations will navigate it.
9. intent.md
The originator describes the problem to Claude in their own words. The originator may describe what they cannot do today, who is affected by the idea, what better looks like, or what is out of scope. No formal language is required.
Brainstorm until the idea is concrete. Claude asks the questions an analyst would ask: scope, users, constraints, and what success looks like.
Ask Claude to write the result as intent.md using the organization's template, which can be encoded as a skill set up by a technical team member and signed off by a lead. This can cover the problem, proposed outcome, affected users and systems, constraints, and open questions.
The originator corrects anything Claude misunderstood.
Commit intent.md to the shared home. Author and timestamp join the record, and the product owner picks the idea up from there.
intent.md
```md
# Intent: claims status self-service
Author: J. Ortiz (claims operations). Status: draft.

## Problem
Customers phone the contact center to ask where their claim is.
Handlers spend roughly a third of call time on status-only queries.

## Proposed outcome
Customers see claim status, next step and expected date in the portal.

## Affected users and systems
Claims handlers, portal team, claims-core API.

## Constraints
No new PII in the portal session. Existing authentication only.

## Open questions
Do third-party loss adjusters need access too?
```
10. plan.md 
```md
# Plan: claims status self-service (from intent.md 2026-06-02)

## Files that change
portal/src/claims/StatusPanel.tsx (new), claims-api/routes/status.py,
claims-api/tests/test_status.py

## Order of work
1. Add the status endpoint behind existing auth.
2. Panel against the endpoint.
3. Wire into the portal nav.

## Risks
The claims-core API rate-limits at 50 rps; the panel must cache.

## Proof
test_status.py covers the four claim states; screenshot matches the
approved mock.
```
11. Spotify推出的Portal插件Shunt利用AiKA模式，将Claude Code的Token消耗削减了90%。

它通过Hook机制拦截Claude的昂贵操作，把读取超长文件和编写样板代码等高耗能、低推理的任务，自动路由给更便宜的Gemini 2.5 Flash等模型处理。Claude仅接收处理后的结构化信息或直接将代码写入磁盘，从而避免在前沿模型上浪费昂贵的上下文配额。

开发者面临的成本压力往往源于I/O而非推理，这种大小模型协作的架构揭示了一个趋势：AI编码的效率提升不再单纯依赖模型升级，而在于工程化的任务解耦。虽然这种模式在处理复杂逻辑或精准编辑时仍有局限，且增加了网络延迟，但它打破了单一模型包揽全局的低效现状。

