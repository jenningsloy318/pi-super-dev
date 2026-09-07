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
