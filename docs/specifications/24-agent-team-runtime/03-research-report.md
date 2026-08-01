# Research Report: Agent Team Runtime

## Sources

1. `docs/requirements/agent-team-runtime.md`.
2. `docs/reference/weichat-agent-team.md`.
3. arXiv 2607.25446v1, **Toward an Organizational Science of Multi-Agent LLM Systems: Decoupling Who, How, and Which Algorithm**.
4. arXiv 2507.01701, **Exploring Advanced LLM Multi-Agent Systems Based on Blackboard Architecture**.
5. A2A Protocol documentation.
6. MCP architecture documentation.
7. Current `pi-super-dev` codebase.

## Findings

### 1. Multiple agents are not enough

The WeChat/CodexLoom article argues that a true Agent Team needs durable identity, domain/scope boundaries, messages, topics, artifacts, Needs You, and owner-level observability. Otherwise Human or a central router still carries responsibility and context.

In `pi-super-dev`, `workflow.ts` currently plays the role of sole router. Therefore `pi-super-dev` is multi-agent but not yet a durable Agent Team.

### 2. WHO / HOW / ALGORITHM must be decoupled

The IMACS paper identifies three independent concerns:

- organization / WHO
- coordination / HOW
- collaboration protocol / ALGORITHM

`pi-super-dev` currently entangles these in stage code. For example, review/integration behavior hard-codes which agent runs, how it coordinates, and which protocol is used.

The first slice should separate WHO via team profiles and RACI; HOW via topic/message/blackboard; ALGORITHM via named protocols.

### 3. Blackboard should be foundational

The bMAS paper proposes a multi-agent architecture where agents contribute to a shared blackboard and a control unit selects contributors based on current blackboard state. This is a better fit for dynamic super-dev runs than only a fixed sequential pipeline.

For `pi-super-dev`, the blackboard should not replace the workflow immediately. Instead, it should record and expose the workflow's current shared state while enabling future dynamic protocol selection.

### 4. A2A and MCP clarify boundaries

A2A distinguishes agent-to-agent communication from tool use. MCP distinguishes host/client/server and stresses isolation: servers should not see whole conversations or other servers.

For `pi-super-dev`, this means:

- Team Messages are the agent-to-agent semantic layer.
- MCP/tools remain individual agent capabilities.
- The workflow/conductor controls what context and artifacts each specialist receives.
- Do not grant every agent full topic history by default.

### 5. Runtime instruction failure proves need for accountable routing

The `248-website-usage-analytics` run showed a late multi-select filter requirement. Prompt injection alone let later agents see it, but earlier green backend phases could be skipped. The fix added invalidation by runtime instruction fingerprint, but the state-of-art design should route such instructions through accountable owners and topic messages.

## Design implications

1. Use spec directory as the topic workspace.
2. Add append-only blackboard and message ledgers.
3. Keep agent communication bounded and checkpoint-delivered at first.
4. Add RACI validation before adaptive routing.
5. Defer learned routing until protocol outcomes are logged.

## Open design decisions resolved for first slice

| Question | Decision |
|---|---|
| Long-running sessions or stateless specialists? | Hybrid: stateless specialists with durable team/topic memory first. |
| State location? | Spec directory. |
| Agent-to-agent autonomy? | Bounded durable messages delivered by workflow checkpoints. |
| Adaptive routing now? | No; log telemetry first. |
| Blackboard public/private spaces? | Start public topic blackboard; private spaces can come later for review/debate. |
