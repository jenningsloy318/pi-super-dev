## communication mechanism 
Status: in progress (draft — parallel-session artifact)
- shared session state: one agent writes a value to the sared session.state dirctionary, the next agent in the sequence read that value from the state to use ints prompt or logic 
- LLM-driven delegation(agent transfer)/orchstrator: the parent(delegator) agent uses tis LLM's reasoning abilith to pair the user's intent with sub-agents, then it generates a transfer_to_agent callto hand off control 
- explicit invocation(agent as a tool): the specialist agent is wrapped in an agentTool and added to the manager agentt's tools list 
| Feature | Agent-as-a-Tool | Sub-Agent |
|---|---|---|
| Who stays in control? | Main agent (Agent A) | Sub-agent (Agent B) takes over |
| Who talks to the user next? | Main agent | Sub-agent |
| What is it used for? | Calling helper agents for single tasks | Handing off full control (e.g. different domain, different task owner) |
| Analogy | Asking a friend to fetch info and report back | Letting your friend take over the meeting |
