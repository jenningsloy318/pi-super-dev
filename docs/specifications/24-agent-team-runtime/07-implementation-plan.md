# Implementation Plan: Agent Team Runtime

## Phase 1 — Team types and default organization

Files:

- `src/team/types.ts`
- `src/team/default-team.ts`
- `src/team/raci.ts`
- `tests/team-raci.test.ts`

Tasks:

1. Define team runtime types.
2. Define default super-dev agent profiles.
3. Define initial RACI assignments.
4. Implement validation.
5. Test unknown refs and accountable-owner constraints.

## Phase 2 — Topic and ledgers

Files:

- `src/team/topic.ts`
- `src/team/blackboard.ts`
- `src/team/messages.ts`
- `src/team/artifacts.ts`
- `tests/team-topic.test.ts`
- `tests/team-blackboard.test.ts`
- `tests/team-messages.test.ts`

Tasks:

1. Implement paths and id generation.
2. Implement idempotent topic initialization.
3. Implement append/read for blackboard.
4. Implement append/reply/read for messages.
5. Implement artifact registration with file hashing.

## Phase 3 — Setup integration

Files:

- `src/setup.ts`
- `tests/setup.test.ts`

Tasks:

1. Initialize topic/ledgers after spec dir creation.
2. Preserve resume compatibility.
3. Add setup regression tests.

## Phase 4 — Stage and agent event integration

Files:

- `src/workflow.ts`
- `src/nodes.ts`
- `tests/team-runtime-workflow.test.ts`

Tasks:

1. Append blackboard events for stage lifecycle.
2. Append blackboard events for agent lifecycle.
3. Ensure append failure is non-fatal.
4. Keep existing progress/UI behavior unchanged.

## Phase 5 — Runtime-change-replan protocol

Files:

- `src/protocols/runtime-change-replan.ts`
- `tests/runtime-change-replan.test.ts`

Tasks:

1. Implement rule-based instruction classifier.
2. For requirement/design changes, send messages to accountable and consulted owners.
3. Update topic current brief.
4. Emit blackboard events.
5. Return invalidation metadata.

## Phase 6 — Workflow runtime instruction integration

Files:

- `src/workflow.ts`
- `src/stages/implementation.ts`
- `tests/workflow-user-steer.test.ts`
- `tests/implementation-convergence-loop.test.ts`

Tasks:

1. When instructions drain, call runtime-change-replan.
2. Use topic-level invalidation metadata as an additional implementation carry invalidation source.
3. Preserve `.user-notes.json` prompt injection.
4. Add regression for multi-select filter instruction routing to backend/frontend/QA.

## Phase 7 — Artifact integration

Files:

- `src/render/render.ts`
- `tests/team-artifacts.test.ts`

Tasks:

1. Register rendered docs as artifacts.
2. Include artifact ids in blackboard events.
3. Keep document rendering unchanged.

## Phase 8 — Documentation

Files:

- `docs/usage.md`
- `README.md` if needed
- `docs/reference/agent-team-runtime.md` if needed

Tasks:

1. Document Multiple Agents vs Agent Team.
2. Document topic/message/blackboard files.
3. Document runtime instruction routing behavior.
4. Document current limits and deferred adaptive routing.

## Phase 9 — Review and validation

Run:

```bash
npm run typecheck
npm test -- tests/team-raci.test.ts tests/team-topic.test.ts tests/team-blackboard.test.ts tests/team-messages.test.ts tests/runtime-change-replan.test.ts tests/team-runtime-workflow.test.ts tests/workflow-user-steer.test.ts tests/implementation-convergence-loop.test.ts tests/setup.test.ts
```

Then run reviewer pass focused on:

- schema durability;
- no raw secrets/base64 in blackboard/messages;
- runtime instruction routing;
- resume compatibility;
- no behavior regression in existing pipeline.
