# Architecture: Agent Team Runtime

## Layered Architecture

```text
L1 Existing tools/models/backends
L2 Existing specialist agents
L3 Team Organization       (profiles + RACI)
L4 Coordination Runtime    (topic + messages + blackboard + artifacts + needs-you)
L5 Collaboration Protocols (runtime-change-replan first)
L6 Existing Workflow       (conductor/checkpoint executor)
L7 Pi Extension UI         (dashboard/cards/status)
```

## Data files per spec

```text
docs/specifications/<spec-id>/
  topic.json
  blackboard.jsonl
  messages.jsonl
  artifacts.jsonl
  .knowledge.json
  .user-notes.json
  change-tracker.jsonl
```

Existing files remain valid; new files provide coordination semantics.

## Team Profile model

```ts
interface AgentProfile {
  id: AgentId;
  runtimeAgent: string;
  identity: string;
  domain: string;
  scope: string;
  stopsAt: string[];
  owns: string[];
  consults?: AgentId[];
  tools?: string[];
}
```

## Organization model

```ts
interface TeamOrganization {
  id: string;
  coordination: "standardized" | "blackboard" | "supervised" | "mutual-adjustment";
  agents: AgentProfile[];
  raci: RaciAssignment[];
  collaborations: CollaborationContract[];
}
```

## RACI model

```ts
interface RaciAssignment {
  deliverable: string;
  responsible: AgentId[];
  accountable: AgentId;
  consulted: AgentId[];
  informed: AgentId[];
}
```

Validation:

- all ids exist;
- accountable exists;
- responsible non-empty;
- exactly one accountable for closure deliverables.

## Topic model

```ts
interface TopicState {
  version: 1;
  id: string;
  specIdentifier: string;
  responsible: AgentId;
  participants: AgentId[];
  currentBrief: {
    goal: string;
    acceptedRequirements: string[];
    designDecisions: string[];
    runtimeInstructions: RuntimeInstructionRef[];
    openQuestions: string[];
    blockedOn: string[];
  };
  artifacts: string[];
  openMessages: string[];
  needsYou: string[];
  completionBoundary: string[];
  updatedAt: string;
}
```

## Blackboard model

Append-only JSONL:

```ts
interface BlackboardEvent {
  id: string;
  topicId: string;
  type: string;
  at: string;
  actor?: AgentId | "human" | "system";
  stage?: string;
  protocol?: string;
  messageId?: string;
  artifactId?: string;
  data?: Record<string, unknown>;
}
```

## Message model

```ts
interface TeamMessage {
  id: string;
  topicId: string;
  from: AgentId | "human" | "system";
  to: AgentId;
  kind: "request" | "reply" | "notification";
  subject: string;
  body: string;
  responseRequired: boolean;
  status: "open" | "answered" | "closed" | "cancelled";
  parentMessageId?: string;
  artifacts?: string[];
  createdAt: string;
  updatedAt: string;
}
```

## Artifact model

```ts
interface TeamArtifact {
  id: string;
  topicId: string;
  type: string;
  path: string;
  hash: string;
  owner: AgentId;
  producedBy: AgentId | "system";
  stage?: string;
  status: "draft" | "accepted" | "rejected" | "superseded";
  messageIds?: string[];
  createdAt: string;
}
```

## Needs You model

```ts
interface NeedsYouItem {
  id: string;
  topicId: string;
  createdBy: AgentId | "system";
  question: string;
  context: string;
  options: Array<{ id: string; label: string; impact: string }>;
  blockedStage?: string;
  resumeHint: string;
  status: "open" | "answered" | "cancelled";
  answer?: string;
  createdAt: string;
  answeredAt?: string;
}
```

## Protocol: runtime-change-replan

Inputs:

- RuntimeInstruction
- TopicState
- TeamOrganization
- current phase/stage state

Outputs:

- classification
- topic brief update
- team messages
- blackboard events
- invalidation descriptor

Classification:

```text
implementation-hint
requirement-change
design-contract-change
qa-expectation
review-correction
docs-release-decision
```

Rule-based first slice:

- words like `require`, `should`, `must`, `expected UX`, `multi-select`, `backend`, `API`, `contract`, `filter` → requirement/design-impacting.
- design/API impacting → route to requirements-owner + architecture-owner and consult backend/frontend/QA.
- implementation-only wording → route to implementation-owner.

## Conductor behavior

Existing workflow remains the conductor. It emits events, initializes ledgers, and invokes protocols at checkpoints.

No specialist may spawn another specialist in the first slice.
