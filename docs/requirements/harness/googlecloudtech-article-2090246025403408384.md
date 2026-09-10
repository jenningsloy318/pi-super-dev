---
source_tweet: "https://x.com/GoogleCloudTech/status/2090248297214525569"
source_article: "https://x.com/i/article/2090246025403408384"
account: "Google Cloud Tech (@GoogleCloudTech)"
article_author: "@shirmeir86"
tweet_created: "2026-08-20T01:23:23Z"
mirror: "https://bittide.aicompass.dev/article/c29f1328-54db-491d-82ec-a095d68e100e"
mirror_cached: "2026-08-25"
saved: "2026-09-08"
---

# What is harness engineering and why should I care?

> **Provenance note.** The source tweet (`status/2090248297214525569`, 2026-08-20) is a
> link-stub pointing at X Article `2090246025403408384`. Direct X access requires
> auth (403 for anonymous fetch; Chrome cookie login timed out), so the article body
> below was recovered from a public mirror cache (bittide.aicompass.dev) of a later
> @GoogleCloudTech promotional tweet for this article. Topic, author, and timeline
> (published ~2026-08-20, references "Arthur Thompson explained today") make the
> match highly likely, but the article-ID equivalence could not be verified
> byte-for-byte against X. Tweet stats at save time: 10 replies / 129 reposts / 703 likes.

How do you ship a software product with 0 lines of manually-written code?

A friend asked me this today, and I realized I didn't have a simple answer. So I dug deeper.

It turns out the answer is in how you engineer your harness.

*by @shirmeir86*

Wait now, what? What is harness engineering?

There is a reason this is **the most important trend** right now around coding agents. The biggest question these days is how to validate AI-generated code without reading every single line. How do you make sure an agent doesn't break production or delete your data?

I recently read about an interesting experiment where a team of 3 engineers have built and shipped an internal beta of a software product with 0 lines of manually-written code. Every line of code: application logic, tests, CI configuration, documentation, observability, and internal tooling, has been written by Codex.

How did they do it? They didn't write the app. They designed the harness.

## What exactly is a harness?

Think of an AI agent like a powerful racehorse. The harness is the track, the blinders, and the jockey's reins that keep it running in the right direction instead of jumping into the stands.

As my colleague Arthur Thompson explained today: for agents — the harness is composed of all the deterministic components that wrap the LLM.

Balaji Subramaniam details those deterministic components in his blog — the orchestration layer, execution sandboxing, state persistence, and verification tools.

If you want to build reliable agentic systems, your job shifts from writing the logic to designing the environment. Here is what you need to focus on:

- **Set strict boundaries:** Don't let the agent guess what it can touch. Enforce strict access rules (like confining it to a specific sandbox) so it can't accidentally wipe out production data.
- **Build "Repair Loops":** Agents will inevitably make mistakes. A great harness automatically traps errors, like a failed build or a test failure, and feeds those clean logs right back to the agent so it can fix its own code.
- **Give them a map, not a manual:** As the OpenAI team discovered, don't overwhelm the agent with massive instruction files. Structure your repository logically so the agent can discover context progressively as it works.

## Show me the code

What does this look like in practice? Here is a simple example using the Google Antigravity SDK with Google's ADK to configure a local harness. Notice how we are strictly bounding the agent to a specific workspace (`workspaces=["./sandbox"]`) and giving it a place to save its memory (`save_dir="./trajectories"`) so it can learn from previous experience:

```python
import os
from google.adk.labs.antigravity import AntigravityAgent
from google.antigravity import LocalAgentConfig
from google.antigravity.hooks import policy

# Ensure absolute paths for workspace containment
sandbox_dir = os.path.abspath("./sandbox")
os.makedirs(sandbox_dir, exist_ok=True)
save_dir = os.path.abspath("./trajectories")

# 1. Engineer the harness environment
sdk_config = LocalAgentConfig(
    system_instructions="You are a helpful local environment assistant.",
    workspaces=[sandbox_dir],  # Let the agent write safely within the restricted sandbox boundary
    policies=[policy.allow_all()],
    save_dir=save_dir,
)

# 2. Wrap the config to run the agent inside the harness
root_agent = AntigravityAgent(
    name="antigravity_assistant",
    description="Runs an Antigravity SDK agent inside ADK.",
    config=sdk_config,
)
```

*(Original article shows a screenshot here: "The policy keeps the agent access only in the Sandbox folder.")*

With this design in place, you can drop your legacy code into the sandbox, write a simple loop to run unit tests against it, and let the agent iteratively fix its own bugs.

## Adding Tests

So, how do we actually run tests against this sandboxed agent?

In modern harness engineering, tests are an active part of the agent's workflow graph. Using Google's ADK 2.0, which introduces graph-based workflows, you can define a test validation step as a simple routing node.

If the test passes, the job is done. If it fails, the harness automatically loops the error back to the agent to try again. Notice the **built-in 'kill switch':** we track the iteration count so if the agent gets stuck in an infinite loop of breaking and fixing code, the harness safely pulls the plug.

```python
from google.adk.agents.context import Context
from google.adk import Event
from google.adk.events.event_actions import EventActions
from google.genai import types

# 3. Evaluate the code in the sandbox
def execution_test_node(ctx: Context):
    # Safely track our attempts to prevent infinite loops
    iteration_count = ctx.state.get("iteration_count", 0) + 1
    ctx.state["iteration_count"] = iteration_count

    test_passed = ctx.state.get("test_passed", False)
    feedback = ctx.state.get("feedback", "")

    if test_passed:
        # Success! End the workflow.
        return Event(actions=EventActions(route="END"))

    if iteration_count > 5:
        # The Kill Switch: The agent is stuck. Stop the loop.
        return Event(actions=EventActions(route="END"))

    # Failure! Feed the error trace back to the agent and loop it.
    feedback_msg = f"The unit tests failed with the following traceback:\n\n{feedback}"

    return Event(
        content=types.Content(role="user", parts=[types.Part(text=feedback_msg)]),
        actions=EventActions(route="loop_back")
    )
```

If you want to see this test routing pattern in action, you can check out an example with a full implementation in Balaji's **ADK harness repository**.

## Wiring it all together using graph-based workflow

To connect the agent and the test node, you can use a Workflow graph to map out exactly how the execution should flow without needing complex, nested Python while loops.

Think of this as drawing the actual lanes on the racetrack:

```python
from google.adk import Workflow

# 4. Wire the agent and the test node together into a loop
repair_loop = Workflow(
    name="repair_loop",
    edges=[
        # 1st Step: Define the main sequence (START -> agent -> test node)
        ("START", root_agent, execution_test_node),

        # 2nd Step: If the test returns "loop_back", go back to the agent
        (execution_test_node, {"loop_back": root_agent})
    ]
)
```

*(Original article shows a screenshot here: "The test loop.")*

Congratulations! you've built an autonomous system. The agent writes the code and hands it off to the test node. If the test fails and returns a `loop_back` route, the agent tries again with the error log in hand.

See more examples of loop patterns in ADK samples.

## Try it yourself

You might wonder why you need a Python script to run an agent. In a normal chat window, you are the harness: you copy the error logs and babysit the model. A software harness lets the system babysit itself, allowing you to fully automate test-driven coding or safely refactor massive legacy codebases.

To run this self-healing loop on your own machine today, the setup takes less than five minutes:

- **Install the framework:** Run `pip install "google-adk[antigravity]"` in your terminal to get the open-source Agent Development Kit and the Antigravity integration.
- **Set your API key:** Grab a free Gemini API key from Google AI Studio and export it to your environment (`export GEMINI_API_KEY="your-key"`).
- **Run the loop:** Save the code blocks above as a Python script, drop a broken Python or Node file into your new `./sandbox` directory, and run your script.
- **Expand your graph:** Unit tests are just the baseline. To make your harness bulletproof, add a second AI agent to your workflow, like a `SecurityAuditor`, to review the code before it passes, or wire in custom linters to enforce strict architectural rules.

From there, you can swap out our simple test node for a subprocess that actually executes `pytest` or `npm test` against your sandbox, and you will have a fully functioning repair loop.

If you are ready to scale this up, you can download the full IDE and CLI at antigravity.google, explore the Antigravity managed agent for remote execution and Google's ADK 2.0 for using graph-based workflows.

## Further reading

My colleagues at Google have put together some incredible guides on where to go next. To learn how to build secure environments for your agents, check out Sara's codelab showcasing Cloud Run sandboxes. If you want to master self-correction, Balaji Subramaniam recently published a deep dive on Loop Engineering for Coding Agents. And to see all of this applied to a massive enterprise use case, read James O'Reilly's breakdown of Automating legacy modernization at scale using agentic pipelines and Antigravity.
