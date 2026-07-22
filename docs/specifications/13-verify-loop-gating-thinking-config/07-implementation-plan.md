# Implementation Plan: Verify-Loop Gating & Per-Agent Thinking Configuration

- **Date**: 2026-07-24

---

## Phase 1: Phase 1 — Verify-loop gating (GAP A/B/C/D)

All edits are confined to src/stages/verify.ts and its test file; the four gaps share the same predicates (reviewApproved, buildGreen), signature/count history state, and loop nodes, so they are implemented and tested together. Add testFailuresSignature + Stage 11 stagnation detection writing state.__testStagnated (GAP A); require reviewApproved AND buildGreen for successful Stage 10 exit (GAP B); add a non-decreasing-count stagnation trigger to both detectors alongside the existing identical-signature trigger (GAP C); add one final budget-checked, non-fatal reviewStep at Stage 10 max-rounds exhaustion (GAP D). Preserve the max-3-round cap and keep every new loop-exit path non-fatal (never throw). Mirror the existing findingsSignature/reviewLoopUntil/__stagnated comment style.
## Phase 2: Phase 2 — Per-agent thinking configuration

Add ThinkingLevel type and thinkingForAgent(agent) role map plus resolveThinking precedence (per-call → SUPER_DEV_THINKING env → role default) in src/pi-spawn.ts; append '--thinking <level>' in buildSpawnArgs; thread thinking? on AgentCall (src/types.ts) into workflow.ts common; add thinkingLevel? to SessionAgentOptions and call session.setThinkingLevel(level) best-effort in try/catch after createAgentSession in src/session-agent.ts. Independent of Phase 1 (disjoint files). Add unit tests for role mapping, override precedence, --thinking argv, and session tolerance.
