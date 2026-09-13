# Agent Team Runtime Requirements

Status: reference — research note (input to dsh-09 R2/P2)

## Context

`pi-super-dev` currently uses many specialist agents, but most work still flows through a central sequential workflow. The specialists are invoked as task executors; they do not yet operate as a durable agent team with explicit responsibility, handoff, current shared state, or accountable ownership.

This document captures the current design analysis from the Agent Team research discussion and turns it into requirements for a future `pi-super-dev` architecture iteration.

## Research basis

- Local reference: `docs/reference/weichat-agent-team.md` — Agent Team best practices from CodexLoom / WeChat article.
- Paper: arXiv `2607.25446v1`, **Toward an Organizational Science of Multi-Agent LLM Systems: Decoupling Who, How, and Which Algorithm**.
- Local failure evidence: background run `248-website-usage-analytics`, where a late runtime requirement changed filters to dropdown-backed multi-select filters but the backend contract was not consistently replanned.
- Current code: `src/workflow.ts`, `src/stages/index.ts`, `src/stages/implementation.ts`, `src/render/user-notes.ts`, `src/types.ts`.

## Core problem

Multiple agents do not automatically form an Agent Team.

Current shape:

```text
workflow.ts / stages/index.ts
  → choose next specialist
  → pass prompt/context
  → collect control output
  → decide next step
```

This means the workflow runtime is still the only real router. Agent identities, responsibilities, collaboration relationships, and accountability are implicit in code and prompts rather than explicit team state.

## Target architecture principles

### 1. Decouple WHO / HOW / ALGORITHM

Following IMACS, separate:

- **WHO — Organization**: which agents exist, what role/domain/scope each owns, which model/tools they use, and who is accountable.
- **HOW — Coordination**: how work moves between agents: standardized procedure, supervisor routing, mutual adjustment, blackboard, messages, human escalation.
- **ALGORITHM — Collaboration protocol**: plan-execute, debate, review-fix-loop, fanout/fanin, reflexion, voting, adaptive routing, etc.

Today these are entangled inside stage/pipeline code.

### 2. Stable domain agents

Each long-lived role needs a profile:

```text
Identity: who this agent is
Domain: what it owns
Scope: where it stops
Inputs: what it accepts
Outputs: what it owns
Escalation: when it needs another agent or human
```

Initial suggested profiles:

- requirements-owner
- research-owner
- architecture-owner
- spec-owner
- implementation-owner
- backend-owner
- frontend-owner
- qa-owner
- review-owner
- docs-owner
- release-owner

### 3. RACI accountability

Every major deliverable should have:

```text
Responsible: agents doing the work
Accountable: exactly one final owner
Consulted: agents whose domain must be checked
Informed: agents needing the result
```

Example:

```text
Runtime requirement change: multi-select filters
Accountable: requirements-owner or architecture-owner
Responsible: backend-owner + frontend-owner
Consulted: qa-owner + review-owner
Informed: docs-owner
```

This prevents late requirements from being applied only to whichever specialist happens to run next.

### 4. Topic per spec

Each spec directory should become a durable Team Topic, not just markdown files.

Proposed file:

```text
docs/specifications/<spec-id>/topic.json
```

Topic contains:

- responsible agent
- participants
- current brief
- accepted requirements
- design decisions
- runtime instructions
- open messages
- artifacts
- Needs You items
- completion boundary

### 5. Messages for bounded cross-agent handoff

Add:

```text
docs/specifications/<spec-id>/messages.jsonl
```

Messages should have sender, receiver, request/reply/notification type, response requirement, status, subject, body, and artifact refs.

Runtime user instructions should become team messages, e.g.:

```text
Human/runtime → requirements-owner:
Runtime requirement change: filters must be dropdown-backed multi-select filters using actual recorded users/pages/sources/referrers.
```

Then requirements-owner or architecture-owner routes bounded requests to backend/frontend/QA owners.

### 6. Blackboard for observability and replay

Add:

```text
docs/specifications/<spec-id>/blackboard.jsonl
```

Events:

- stage.started / stage.completed
- agent.started / agent.completed
- message.sent / message.replied
- artifact.created
- runtime_instruction.received
- gate.failed / gate.passed
- raci.assigned
- needs_you.created / needs_you.resolved

This is the transparent room / blackboard layer recommended by the IMACS paper and needed for owner-level observability.

### 7. Artifact registry

Add:

```text
docs/specifications/<spec-id>/artifacts.jsonl
```

Artifacts should include id, type, path, hash/version, owner, producing agent, stage, status, and linked message/topic.

This prevents ambiguity about which version of a spec/review/report is authoritative.

### 8. Needs You

Human input should be represented as a precise durable decision point, not a vague pause.

Needs You item includes:

- what work is blocked
- facts already known
- exact missing human decision/fact/authorization
- options and impact
- where execution resumes after answer

### 9. Runtime instruction replan protocol

Current freeform instructions are persisted and injected. Future Team behavior should classify them:

- implementation hint
- requirement change
- design/architecture contract change
- QA expectation
- review correction
- release decision

Requirement/design-impacting instructions trigger `runtime-change-replan`:

```text
runtime instruction
  → requirements-owner classifies impact
  → architecture-owner updates current brief/contracts
  → backend/frontend/QA owners receive bounded messages
  → affected phases invalidate and rerun
```

### 10. Protocol registry

Add explicit protocols under `src/protocols/`:

- requirements-interview
- parallel-research-synthesis
- design-debate
- spec-trace-gate
- implementation-convergence
- review-adversarial-merge
- runtime-change-replan
- integration-fix-rereview
- docs-drift-reconcile

Do not hard-code all team/coordination/protocol behavior inside stage definitions.

## Immediate recommended implementation slice

Do **not** start with full adaptive routing.

First implement:

1. `src/team/types.ts`
2. `src/team/default-team.ts`
3. `src/team/raci.ts`
4. `src/team/topic.ts`
5. `src/team/messages.ts`
6. `src/team/blackboard.ts`
7. `src/protocols/runtime-change-replan.ts`

Acceptance for first slice:

- setup initializes `topic.json` and `blackboard.jsonl`;
- default team profile validates;
- RACI requires at most/exactly one accountable owner where appropriate;
- runtime instruction creates blackboard event and team message;
- requirement-impacting runtime instruction invalidates implementation carry through topic-level state;
- tests prove multi-select-filter style change routes to backend + frontend + QA, not only the next specialist.

## Open questions for design phase

1. Should domain agents be long-running Pi sessions, or stateless specialists with durable topic/team memory?
   - Recommended initial answer: hybrid — stateless specialist execution with durable topic/team memory.
2. Should blackboard live in spec dir or `.pi/super-dev/runs`?
   - Recommended initial answer: spec dir for feature-specific team state.
3. How autonomous should agent-to-agent routing be?
   - Recommended initial answer: bounded messages emitted by protocols, delivered at workflow checkpoints.
4. When should adaptive protocol routing be introduced?
   - Recommended initial answer: after we have protocol telemetry and outcome rewards.

## Success criteria

A future `super-dev` run should answer:

- Who owns this deliverable?
- Which agents are responsible/consulted/informed?
- What is the current accepted brief?
- Which runtime instructions were received and how were they routed?
- Which messages are open or answered?
- Which artifacts are authoritative?
- Which gate is blocked and whose responsibility it is?
- Why did the workflow choose this protocol?

Only then does `pi-super-dev` begin to behave like an Agent Team rather than a sequential multi-agent workflow.

---

# Third Research Addendum — State-of-Art Check

## Additional sources checked

1. **arXiv 2607.25446v1 — IMACS: Toward an Organizational Science of Multi-Agent LLM Systems**
   - Core thesis: decouple **WHO** (organization), **HOW** (coordination), and **ALGORITHM** (collaboration protocol).
   - Organization should be declarative and validated: roles, model bindings, coordination mechanism, and RACI.
   - Protocol selection can become adaptive when outcome/cost telemetry exists.

2. **arXiv 2507.01701 — Exploring Advanced LLM Multi-Agent Systems Based on Blackboard Architecture**
   - Core thesis: blackboard-based MAS lets agents share a durable problem state, select next contributors dynamically, and iterate until consensus.
   - General bMAS components: control unit, blackboard, agent group.
   - Useful roles: planner, decider, critic, cleaner, conflict-resolver.
   - Important warning: fixed workflows are less flexible for dynamic problems; blackboard enables timely adaptation based on current shared content.

3. **WeChat / CodexLoom Agent Team article**
   - Core thesis: multiple agents become a team only when responsibility, domain/scope, handoff, current status, artifacts, and human governance are externalized into durable structures.
   - Key primitives: Profile, Organization, Collaboration, Message, Topic, Artifact, Needs You, Overview.
   - Human moves from step-by-step router to team owner/governor.

## Updated synthesis

The proposed architecture is still directionally correct, but the third research pass changes the implementation priority:

1. **Blackboard must be foundational, not optional.**
   - IMACS and bMAS both require a durable shared state for coordination. For super-dev this should be `blackboard.jsonl` in the spec directory.
   - `.knowledge.json`, `.user-notes.json`, `change-tracker.jsonl`, and run logs should feed into it or be linked from it.

2. **Agent Team should not start as free-form peer chat.**
   - bMAS shows all agent communication can go through the blackboard. CodexLoom shows Message/Topic gives causality and closure.
   - Therefore first implementation should be durable structured messages, not uncontrolled live agent-to-agent spawning.

3. **Control unit remains necessary, but should become explicit.**
   - The current workflow is an implicit control unit.
   - It should evolve into a `Conductor` that reads topic + blackboard + team profiles and selects protocols/agents.

4. **Protocol routing should be rule-based first, adaptive later.**
   - IMACS Adaptive Org Routing requires telemetry and reward signals. We do not have enough historical, normalized rewards yet.
   - Start with explicit protocols and log outcomes. Learn routing later.

5. **Runtime instructions must be team-level events.**
   - The multi-select filter failure shows prompt injection alone is insufficient.
   - Runtime instructions should create blackboard events + messages to the accountable owner, then trigger a replan protocol.

## Recommended revised first implementation slice

The first Agent Team slice should implement these in order:

1. `src/team/default-team.ts` — stable profiles and domain/scope declarations.
2. `src/team/raci.ts` — RACI validation, exactly one accountable owner for deliverables that require closure.
3. `src/team/blackboard.ts` — append-only `blackboard.jsonl` event ledger.
4. `src/team/topic.ts` — `topic.json` current brief, responsible, participants, artifacts, needs-you.
5. `src/team/messages.ts` — request/reply/notification messages with causal ids.
6. `src/protocols/runtime-change-replan.ts` — convert runtime instruction into accountable replan message and affected phase invalidation.
7. Integrate with setup and `workflow.ts` so every run initializes topic/blackboard and emits events.

## What should be deferred

- Adaptive contextual-bandit protocol routing.
- Fully autonomous peer-to-peer live delegation.
- External interface / outbox governance.
- Complex capacity/token overview dashboards.

These need telemetry and stable team primitives first.

## Confidence after third research

High confidence on the **architecture direction**:

```text
Team Profile + RACI + Topic + Message + Blackboard + Artifact + Needs You + Protocol Registry
```

Medium confidence on exact schemas and initial agent set; these should be finalized in the dedicated `24-agent-team-runtime` specification.

Low confidence on adaptive routing implementation timing; it should wait until blackboard telemetry exists.
