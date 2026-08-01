# Requirements: Agent Team Runtime

## Summary

Evolve `pi-super-dev` from a centrally-routed multi-agent workflow into a durable Agent Team runtime. The first implementation slice must externalize team responsibility, current work state, bounded cross-agent communication, and observability into spec-directory artifacts while preserving the existing deterministic workflow and specialist execution model.

## Problem Statement

`pi-super-dev` already invokes many specialists, but the workflow still behaves like a sequential orchestrator:

```text
workflow/stage code chooses the next specialist
workflow/stage code passes context
specialist returns control JSON
workflow/stage code decides next step
```

This makes `workflow.ts` and `stages/index.ts` the sole router. Agents do not have durable team identity, responsibility boundaries, RACI accountability, message causality, or a shared blackboard. Runtime user instructions are persisted and injected, but they are not yet routed as team-level work items through accountable owners.

## Goals

- Introduce a durable Agent Team substrate without rewriting the whole pipeline.
- Make **WHO / HOW / ALGORITHM** separate design surfaces:
  - WHO: team profiles, domains, scopes, RACI.
  - HOW: topic, messages, blackboard, artifacts, Needs You.
  - ALGORITHM: named collaboration protocols, starting with runtime-change-replan.
- Store team state in each spec directory so a feature run can be inspected, resumed, and audited.
- Convert runtime instructions into team-visible events and messages, not just prompt text.
- Preserve existing deterministic stage execution; no unconstrained live peer-to-peer spawning in the first slice.

## Non-goals for first slice

- No adaptive contextual-bandit routing yet.
- No external Slack/Feishu/outbox governance yet.
- No fully autonomous peer-to-peer agent spawning.
- No replacement of the existing node algebra.
- No long-running persistent Pi session per domain agent yet.

## Functional Requirements

### FR-01 Team profile registry

The system MUST define a default `super-dev` team with stable agent profiles.

Each profile MUST include:

- id
- runtime agent name
- identity
- domain
- scope
- stopsAt boundaries
- owned deliverables
- default consultation links

Initial profiles MUST include at least:

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

### FR-02 RACI validation

The system MUST define RACI assignments for major deliverables and validate that deliverables requiring closure have exactly one Accountable owner.

RACI entries MUST support:

- deliverable id
- responsible agents
- accountable agent
- consulted agents
- informed agents

### FR-03 Topic initialization

Setup MUST initialize a `topic.json` in the spec directory.

The topic MUST include:

- topic id / spec id
- responsible agent
- participants
- current brief
- accepted requirements
- design decisions
- runtime instructions
- open messages
- artifact refs
- Needs You refs
- completion boundary

### FR-04 Blackboard event ledger

Setup MUST initialize an append-only `blackboard.jsonl` in the spec directory.

The system MUST append events for:

- topic.created
- stage.started / stage.completed / stage.failed / stage.skipped
- agent.started / agent.completed / agent.failed
- runtime_instruction.received
- message.sent / message.replied / message.closed
- artifact.created / artifact.accepted / artifact.rejected
- gate.passed / gate.failed
- raci.assigned
- needs_you.created / needs_you.resolved

### FR-05 Message ledger

The system MUST store bounded cross-agent messages in `messages.jsonl`.

Message fields MUST include:

- id
- topicId
- from
- to
- kind: request | reply | notification
- subject
- body
- responseRequired
- status: open | answered | closed | cancelled
- parentMessageId / causal links
- artifact refs
- createdAt / updatedAt

### FR-06 Artifact registry

The system MUST store artifact metadata in `artifacts.jsonl`.

Artifact fields MUST include:

- id
- topicId
- type
- path
- hash
- owner
- producing agent
- stage
- status
- linked message ids
- createdAt

### FR-07 Runtime instruction routing

When the user types/pastes/attaches content during a run, the system MUST:

1. capture the runtime instruction as today;
2. append a blackboard event;
3. add it to `topic.currentBrief.runtimeInstructions`;
4. create a team message to the accountable owner for runtime changes;
5. classify impact with the `runtime-change-replan` protocol;
6. invalidate affected implementation carry when needed.

### FR-08 Runtime-change-replan protocol

The first explicit protocol MUST be `runtime-change-replan`.

It MUST classify runtime instructions into:

- implementation hint
- requirement change
- design/architecture contract change
- QA expectation
- review correction
- release/docs decision

For requirement/design-impacting instructions, it MUST create messages to the relevant owners and mark affected phases/stages for reconsideration.

### FR-09 Checkpoint integration

The existing workflow MUST emit blackboard events at checkpoints without changing stage semantics:

- before/after stage
- before/after agent call
- gate pass/fail
- runtime note drain
- artifact render/write

### FR-10 Backward compatibility

Existing files (`.knowledge.json`, `.user-notes.json`, `change-tracker.jsonl`) MUST continue to work. New team-runtime files may link to them but must not break existing resume behavior.

## Non-functional Requirements

### NFR-01 Durable and inspectable

Team state must be plain JSON/JSONL in the spec directory.

### NFR-02 Append-only where possible

Blackboard, messages, and artifacts should be append-only or append-mostly to preserve audit trails.

### NFR-03 No hidden autonomous authority

Agents may propose messages/routing, but first slice delivery is controlled by the workflow/conductor at checkpoints.

### NFR-04 Fail-soft observability

Failure to append a non-critical event should not abort the run, but missing team files during setup should be initialized/repaired.

### NFR-05 Security boundaries

Team messages and blackboard entries must not include raw secrets or raw image base64. Artifact refs should point to persisted paths/hashes.

## Acceptance Summary

The first Agent Team runtime slice is accepted when a run can answer:

- Who owns this deliverable?
- Which agents are responsible/consulted/informed?
- What is the current accepted brief?
- Which runtime instructions were received and how were they routed?
- Which messages are open/answered?
- Which artifacts are authoritative?
- Which gate is blocked and whose responsibility it is?
