Status: ANSWERED — scratch Q&A note (not a plan doc); feel free to move or delete

# What's the difference between how super-dev spawns subagents vs how pi does with async — can we use the same?

**Short answer:** they already share the same substrate — both spawn child `pi` processes — but they are two different *contracts* on top of it. Unifying the spawner would buy little; what differs is orchestration, lifecycle, and who decides continuation.

**pi-native subagents (what this session uses for grill/review/implement groups):**
- General delegation primitive: parent LLM session spawns a child with an arbitrary task, optional skill(s), model override, fresh/fork context, tool allowlist.
- `async: true` = detached background run with a *native completion notification* that wakes the parent session; `async: false` blocks the parent.
- Interactive lifecycle: supervisor channel (`contact_supervisor` — one-question-at-a-time HITL), steer/resume for live or finished runs, intercom between sessions, artifacts and session logs.
- Budgets: optional per-child toolBudget/usageBudget; the parent agent is the orchestrator.

**super-dev's agent spawning (agent-runtime.ts, sd-* roles):**
- Engine-driven pipeline roles: each call is a child `pi` process carrying a role prompt + TypeBox control schema + structured-output parser, wrapped in harness machinery (gates, TDD boundary, judge verification, convergence loops, replan circuit).
- No interactivity mid-stage by design: an agent never asks the human — deterministic gates and the judge route outcomes instead (P4: prompts advisory, enforcement mechanical).
- Async semantics are *awaited* calls inside stages, bounded per tier (code ~30min, judge 20min as of v0.3.85) and globally by spawn/cost/token budgets — and, as of Group 2 today, the run wall fuse (`partial (wall-fuse)` wind-down). The ENGINE decides continuation, not a parent LLM.
- Lifecycle is the run's: resume cache, phase commits, HARNESS_FILE_ROLES ledger discipline.

**"Can we use the same?"** Partially, and it's already happening where it makes sense: v0.3.84+ serves super-dev capability agents through the same extension set (`commonExtensions`), and v0.3.86's S4 aligns the tool-budget surface. What should NOT be unified blindly: pi-subagents' interactive steering exists to serve a human-in-the-loop parent; super-dev's agents must stay mechanically governed (P1/P4) — an sd-implementer that could be steered ad-hoc mid-phase is exactly the v0.3.43-era hazard class. Full spawner unification is an §11-era architecture question, not a v0.3.85 one.
