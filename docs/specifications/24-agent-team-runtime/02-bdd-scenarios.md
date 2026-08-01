# BDD Scenarios: Agent Team Runtime

## SCENARIO-001 — Setup creates Team Topic files

Given a new super-dev run starts
When setup creates the spec directory
Then `topic.json`, `blackboard.jsonl`, `messages.jsonl`, and `artifacts.jsonl` exist
And `topic.json` identifies a responsible agent and participants
And `blackboard.jsonl` contains a `topic.created` event.

## SCENARIO-002 — Default team validates

Given the default super-dev team profile registry
When team validation runs
Then every referenced agent id exists
And each deliverable requiring closure has exactly one accountable owner
And no RACI assignment references an unknown agent.

## SCENARIO-003 — Runtime instruction becomes team-visible work

Given a background super-dev run is active
When the user types `filters must be dropdown-backed multi-select using actual recorded users/pages/sources/referrers`
Then `.user-notes.json` stores the instruction
And `blackboard.jsonl` receives `runtime_instruction.received`
And `topic.json.currentBrief.runtimeInstructions` includes the instruction
And `messages.jsonl` has a request to the accountable requirements or architecture owner.

## SCENARIO-004 — Requirement-impacting runtime instruction routes to backend/frontend/QA

Given a runtime instruction is classified as a design/API contract change
When `runtime-change-replan` runs
Then messages are created to backend-owner, frontend-owner, and qa-owner
And the topic current brief records the contract change
And implementation carry is invalidated for affected phases.

## SCENARIO-005 — Implementation hint does not trigger full replan

Given a runtime instruction is a local implementation hint
When `runtime-change-replan` runs
Then it is appended to topic current brief
But no architecture/backend/frontend/QA replan messages are required
And phase invalidation is limited to the relevant implementation phase if known.

## SCENARIO-006 — Artifact registry records rendered documents

Given a stage renders `08-specification.md`
When the artifact is written
Then `artifacts.jsonl` contains an artifact entry with path, hash, owner, producing agent, and stage
And `blackboard.jsonl` contains `artifact.created`.

## SCENARIO-007 — Gate failure is accountable

Given a deliverable gate fails
When the gate result is recorded
Then `blackboard.jsonl` contains `gate.failed`
And the event includes the accountable owner for the deliverable
And the topic current brief includes the blocked status.

## SCENARIO-008 — Needs You is durable

Given a protocol needs a human decision
When it cannot proceed safely
Then a Needs You item is added to the topic
And `blackboard.jsonl` contains `needs_you.created`
And the item includes question, context, options, impact, and resume location.

## SCENARIO-009 — Existing resume remains compatible

Given an older spec directory without team runtime files
When super-dev resumes
Then missing team runtime files are initialized or repaired
And existing `.knowledge.json`, `.user-notes.json`, and `.resume-cache.jsonl` remain usable.

## SCENARIO-010 — No raw binary/secrets in blackboard

Given a runtime instruction includes an image attachment
When the instruction is recorded
Then blackboard/message/topic entries reference a persisted artifact path/hash
And do not store raw base64 payloads.
