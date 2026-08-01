# Task List: Agent Team Runtime

## P1 — Team Organization

- [ ] Create `src/team/types.ts`.
- [ ] Create `src/team/default-team.ts`.
- [ ] Create `src/team/raci.ts`.
- [ ] Add tests for valid default organization.
- [ ] Add tests for unknown agent references.
- [ ] Add tests for accountable-owner constraint.

## P2 — Topic and Ledgers

- [ ] Create `src/team/topic.ts`.
- [ ] Create `src/team/blackboard.ts`.
- [ ] Create `src/team/messages.ts`.
- [ ] Create `src/team/artifacts.ts`.
- [ ] Add idempotent `ensureTeamRuntimeFiles()`.
- [ ] Add tests for topic initialization.
- [ ] Add tests for blackboard append/read.
- [ ] Add tests for message append/reply.
- [ ] Add tests for artifact hashing/registration.

## P3 — Setup and Workflow Events

- [ ] Initialize team runtime files in `runSetup()`.
- [ ] Emit setup/topic-created events.
- [ ] Emit stage lifecycle blackboard events.
- [ ] Emit agent lifecycle blackboard events.
- [ ] Add non-fatal append-failure tests.

## P4 — Runtime Change Replan

- [ ] Create `src/protocols/runtime-change-replan.ts`.
- [ ] Classify implementation hints vs requirement/design changes.
- [ ] Create messages for runtime changes.
- [ ] Update topic current brief.
- [ ] Emit blackboard events.
- [ ] Integrate with runtime instruction drain in `workflow.ts`.
- [ ] Add multi-select filter routing regression.

## P5 — Implementation Carry Integration

- [ ] Connect topic/runtime-change invalidation to `implementationStage`.
- [ ] Preserve existing runtime instruction fingerprint behavior.
- [ ] Add test that backend/frontend/QA owners are consulted for filter-contract changes.

## P6 — Documentation

- [ ] Update usage/reference docs.
- [ ] Document file schemas.
- [ ] Document limitations and deferred adaptive routing.

## P7 — Review / Integration / Merge

- [ ] Typecheck.
- [ ] Targeted tests.
- [ ] Reviewer pass.
- [ ] Merge to main.
