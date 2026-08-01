# Code Assessment: Agent Team Runtime

## Current architecture map

### `src/workflow.ts`

Owns StageContext and the `ctx.agent()` primitive. It currently:

- injects feedback from gates;
- injects `.knowledge.json` into agent prompts;
- drains runtime user notes;
- chooses session vs subprocess backend;
- handles transient retry;
- accumulates `ctx.results`.

This is the right integration point for agent.started/agent.completed events and checkpoint-delivered messages.

### `src/stages/index.ts`

Defines the top-level workflow sequence and phase order. It currently entangles organization, coordination, and protocols. This should remain operational but gradually call explicit protocol helpers.

### `src/stages/implementation.ts`

Contains convergence logic, per-phase TDD, deliverable gates, runtime instruction fingerprinting, and change tracking. It is the first place to integrate runtime-change-replan.

### `src/render/user-notes.ts`

Persists runtime user notes and attachments. It should feed blackboard/topic runtime instruction events.

### `src/render/knowledge.ts`

Maintains `.knowledge.json`; should remain as prior-stage data, but topic current brief should become the coordination-level summary.

### `src/tracking.ts`

Change tracking emits useful evidence for artifacts/blackboard events.

### `src/nodes.ts`

The node algebra emits stage lifecycle events and can be used to append blackboard stage events without rewriting stage modules.

### `src/setup.ts`

Creates worktree/spec directory. This is the right place to initialize `topic.json`, `blackboard.jsonl`, `messages.jsonl`, and `artifacts.jsonl`.

## Gaps

1. No Team Profile registry.
2. No RACI validation.
3. No topic current brief.
4. No durable message ledger.
5. No blackboard event ledger.
6. No artifact registry.
7. Runtime instructions are notes, not accountable team messages.
8. Protocols are implicit in stage code.

## Constraints

- Existing pipeline must continue to pass current tests.
- First slice must be additive and backward compatible.
- New team files should be repairable if missing on resume.
- Event append failures should not crash non-critical workflow paths.
- Setup initialization should be deterministic and no-LLM.

## Proposed code additions

```text
src/team/types.ts
src/team/default-team.ts
src/team/raci.ts
src/team/topic.ts
src/team/messages.ts
src/team/blackboard.ts
src/team/artifacts.ts
src/protocols/runtime-change-replan.ts
```

## Proposed integration points

- `setup.ts`: initialize topic/team ledgers.
- `nodes.ts` or `workflow.ts`: append stage events.
- `workflow.ts`: append agent events and message delivery events.
- `render/user-notes.ts` or extension input handler: append runtime instruction events.
- `implementation.ts`: read topic/runtime instruction state to invalidate affected phases.
