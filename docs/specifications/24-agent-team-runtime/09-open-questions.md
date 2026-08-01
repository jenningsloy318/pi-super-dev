# Open Questions and Resolutions: Agent Team Runtime

## Q1: Should domain agents be long-running sessions?

Initial resolution: no. Use stateless specialist execution with durable topic/team memory. Long-running domain sessions can be added once the durable team substrate proves useful.

## Q2: Should team state live in spec dir or global run dir?

Initial resolution: spec dir. Team state belongs to the feature topic and must survive resume, review, and handoff.

## Q3: Should agents directly spawn each other?

Initial resolution: no. First slice uses bounded durable messages delivered at workflow checkpoints. This keeps child-safety and budget control intact.

## Q4: Should blackboard include private spaces?

Initial resolution: no for first slice. Use public append-only topic blackboard. Private debate/review spaces can be added after the message/topic model stabilizes.

## Q5: Should adaptive protocol routing be implemented now?

Initial resolution: no. First collect protocol/outcome telemetry; adaptive routing comes later.

## Q6: How to prevent context explosion?

Initial resolution: agents do not receive the full blackboard by default. The conductor passes relevant current brief, messages, and artifacts scoped to the stage/protocol.

## Q7: How to handle sensitive data?

Initial resolution: blackboard/messages/artifacts store refs and summaries, not raw secrets or binary blobs. Existing safety rules still govern tool access.
