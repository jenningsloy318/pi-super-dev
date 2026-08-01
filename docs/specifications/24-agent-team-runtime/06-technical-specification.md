# Technical Specification: Agent Team Runtime

## Module layout

```text
src/team/types.ts
src/team/default-team.ts
src/team/raci.ts
src/team/topic.ts
src/team/messages.ts
src/team/blackboard.ts
src/team/artifacts.ts
src/team/index.ts
src/protocols/runtime-change-replan.ts
```

## `src/team/types.ts`

Exports all shared Team Runtime types:

- `AgentId`
- `AgentProfile`
- `TeamOrganization`
- `RaciAssignment`
- `TopicState`
- `BlackboardEvent`
- `TeamMessage`
- `TeamArtifact`
- `NeedsYouItem`
- `RuntimeChangeClassification`
- `RuntimeChangeReplanResult`

## `src/team/default-team.ts`

Exports `DEFAULT_SUPER_DEV_TEAM`.

Required profiles:

| id | runtimeAgent | domain |
|---|---|---|
| requirements-owner | requirements-clarifier | goals, ACs, NFRs, runtime requirement changes |
| research-owner | research-agent | external/domain research |
| architecture-owner | architecture-designer | cross-system design and backend/frontend contracts |
| spec-owner | spec-writer | executable specification and plan |
| implementation-owner | implementer | implementation convergence and code changes |
| backend-owner | implementer | backend/API/data model implementation |
| frontend-owner | implementer | frontend/UI/client implementation |
| qa-owner | qa-agent | tests, build, integration evidence |
| review-owner | code-reviewer | review verdict and issue taxonomy |
| docs-owner | docs-executor | docs drift and handoff |
| release-owner | orchestrator | merge/release readiness |

## `src/team/raci.ts`

Exports:

```ts
validateTeamOrganization(team): ValidationResult
ownerForDeliverable(team, deliverable): AgentId | undefined
```

Validation errors are structured; no throw for normal validation.

## `src/team/topic.ts`

Exports:

```ts
initTopic(specDir, input): TopicState
loadTopic(specDir): TopicState | null
saveTopic(specDir, topic): void
updateTopic(specDir, updater): TopicState
ensureTeamRuntimeFiles(specDir, init): TopicState
```

`ensureTeamRuntimeFiles` is idempotent and safe for resume.

## `src/team/blackboard.ts`

Exports:

```ts
blackboardPath(specDir): string
appendBlackboardEvent(specDir, event): BlackboardEvent | null
readBlackboardEvents(specDir): BlackboardEvent[]
```

Events get generated ids and timestamps if omitted.

Append failures are swallowed but may be logged through optional callback later.

## `src/team/messages.ts`

Exports:

```ts
appendTeamMessage(specDir, message): TeamMessage | null
replyToMessage(specDir, parentId, reply): TeamMessage | null
readTeamMessages(specDir): TeamMessage[]
openMessagesFor(specDir, agentId): TeamMessage[]
```

## `src/team/artifacts.ts`

Exports:

```ts
registerArtifact(specDir, artifact): TeamArtifact | null
hashFile(path): string | null
readArtifacts(specDir): TeamArtifact[]
```

First slice registers rendered stage documents and runtime instruction attachments where easy. Full artifact coverage can expand later.

## `src/protocols/runtime-change-replan.ts`

Exports:

```ts
classifyRuntimeInstruction(instruction): RuntimeChangeClassification
runRuntimeChangeReplan(input): RuntimeChangeReplanResult
```

`runRuntimeChangeReplan` appends messages/events and updates topic state.

## Setup integration

In `runSetup()`:

1. create spec directory;
2. initialize topic and ledgers;
3. append `topic.created` and `stage.started/setup` events.

## Workflow integration

In `makeContext()` / `realAgent()`:

- before backend spawn: append `agent.started`;
- after backend returns: append `agent.completed` or `agent.failed`;
- when runtime instructions drain: run `runtime-change-replan` for new instructions;
- still call `appendUserNotes` for prompt injection compatibility.

## Node/stage integration

In `task(stage)` or workflow event subscriber:

- `stage.running` → blackboard `stage.started`;
- terminal statuses → blackboard `stage.completed` / `stage.failed` / `stage.skipped`.

## Runtime instruction replan integration

When `userSteerProvider()` returns instructions:

1. persist to `.user-notes.json`;
2. append blackboard `runtime_instruction.received`;
3. create team message according to classification;
4. update topic current brief;
5. return user notes string to prompt as today.

## Test plan

- pure team validation tests;
- topic init/load/update tests;
- blackboard append/read tests;
- message append/reply tests;
- runtime-change-replan classification tests;
- integration test from fake runtime instruction → messages to backend/frontend/QA;
- existing setup/workflow tests remain green.
