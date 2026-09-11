## part 1 
Status: draft (eval-layer spec — companion to sdlc-tips-adoption.md D1-D6)
The best way to get good at evals is to  take a workflow you know really well and figure out how to make its quality measurable.

Study the actual traces - the sequence of prompts typical users have, what good responses would look like at each step and for the end to end outcome.

Study where your product fails and create traces that capture them - messy tool call responses, missing context etc.

Once you have a good eval, think about how you would make it easy to run repeatedly and automatically.

Once you have that, think about how you will ensure your eval continues to mirror live traffic as your users patterns evolve.

This could be a series. Would you guys like me to write about it everyday?
## part 2 
Here’s how to think about the cost of your evals : treat evals like frontier models…establish the quality frontier first, then work your way down the cost curve.

Start with the highest quality way you can know if your AI product is working as intended.

First get clear on what good looks like - Write the rubric.

Then figure out the best way to measure it - humans /  LLM judge / automated verification.

At this stage, spend the money - use the expensive judge model, pay humans (or give your time). Run the best eval process possible so you get a signal you trust.

Once the eval can reliably distinguish good from bad and reflects what you care about in the product, focus on costs - more automation, smaller judge models, sampling, deterministic checks where relevant.

Quality first. Cost next.

this is a series. drop any questions you have and I will answer them in my daily posts.
## part 3 
The best way to get good at evals - Part 3.

Let’s talk failure modes taxonomy - that’s the first thing you should build once you have v1 of your evals.

Start with your production traces - study the last 500 or 1,000 interactions and look at the failures. Cluster them and name the clusters.

Get specific - “bad answer” isn’t a useful cluster name.

Specific failures - wrong document retrieved / right document but irrelevant section / failed to ground to context and hallucinated /  failed to punt on answer and instead made stuff up / question ambiguous  and made poor assumptions rather than asking clarifying questions etc.

Those are very different problems.

Once you can name the failure precisely, you can build eval tests specifically designed to catch it.

You now have the bridge from evals to an improvement flywheel. More tomorrow…

## part 4
How to build great evals - part 4

The reason enterprises struggle with building decent AI systems is the lack of an eval strategy.

You need a laddered eval strategy, for your unique use cases,
with multiple evals on the cost/realism spectrum.

Here are the key kinds of evals you need:

Hill-climb long evals : this pushes the frontier of your product and you need to continually refresh this to improve quality and expand your feature base.

Regression evals : Did we break the product of today while hill climbing?

Smoke test evals: safety and the absolute basics that just can’t go wrong. Not necessarily hard questions, but important to not get wrong. Eg product identity.

Launch evals: often close to an online test with real-ish traffic. Less control, but the most realistic.

More in tomorrow’s post!

Share with your teammates who will benefit!
## part 5 
How to build great evals - part 5

Stop dumbing down the results from your beautiful, complex eval suite into one single score. This often happens because some senior wants a simplified number to make decisions. Happened to us in the early days of Gemini.

And I see it happening with a lot of teams.

This is the tyranny of the average.
AI systems do not have a simple dimension of quality.

Imagine a model that goes from:
85% -> 89% on simple summarization
80% -> 85% on basic factual QA
70% -> 63% on complex financial analysis

A single score obscures the fact that the model got worse on your frontier use case.

The immediate reaction to this is to come up with a weighted score. The problem with this is that you have  created false, mathematical procession around a judgment call.

So what should you do?
- keep a prioritized list of your evals per the ladder we discussed in part 4 yesterday.
- get people who can look at the details and don’t look for abstracted simplicity.
- Understand all the critical eval results in depth, where they fail, where they shine and make a decision on whether your new AI system is better or worse for your users.

Next post tomorrow!

Drop your eval questions below and I will answer in future posts.

Share this with your teammates. And your managers who run from complexity.

## part 6 
How to build great evals - part 6

Hill climbing on evals is just a fancy way of saying: pick a dimension that matters and optimize for it.

This could be improving the quality of existing features based on your latest production data on high value user journeys, expanding to adjacent use cases, lowering cost or latency.

The actual work boils down to better harnesses and model selection through methods like prompt eng, context eng, memory, post training, deterministic old school code etc.

Your failure mode taxonomy (from part 3) is a good compass for where your product struggles and needs some love.

E.g. maybe tool calling failures are your most common problem. You dig in and notice you stuff 20 tools in context, when each task really only needs 3-5. hill climbing here involves context eng to give it the right tools at the right stage and iterate until you get it to good.

Or take the cost reduction goal..
I’ve written about how I advise launching your product with the best model first. Get the quality as high as you can. Once you know users love the experience, hill climb to get similar quality with a smaller, cheaper, faster model. Same methods - harness, models.

The important thing is to have evals that tell you whether you are actually moving in the right direction.

More tomorrow.

Send this to your teammates!

Drop your questions in the comments and I will answer in future posts.

## part 7
How to build great evals - part 7.

The Goldilocks principle for eval construction.

Your evals should measure at the level of the various jobs to be done, not just the final answer.

E.g. consider a financial analysis agent. It's ultimate output is a stock recommendation. The most common mistake I see is teams create a golden set of right answers and check if the agent recommended the "right” stock.

The problem here is that there are probably a bunch of meaningful jobs that happened before this recommendation. E.g.

1/ Understanding the client: their portfolio, risk tolerance, investment horizon, goals, constraints

2/ Gather evidence: latest data points on the different stock stocks, the sectors, macro environment, Fed policy, recent and upcoming news events

3/ Analyze the data: revenue growth, valuation guidance, growth projections and produce a narrower number of candidate stocks

4/ Make a recommendation: stock ticker name, bid/sell price, timeframe

Each of these is a stage and produces an intermittent output. Each of them can (and maybe should have) their own eval so you can diagnose issues.

If the final recommendation is wrong, a well designed eval set would tell you:
Client understanding : 92%,
Evidence extraction : 92%,
Data analysis: 70%
Recommendation: 75%

Now you know where to go dig. And you might go, man the data analysis step is too complex and I need to break it down into a set of jobs to be done, and construct eval sets for them.

Not too granular. Not too coarse. Just right.
Make your eval set as granular as you need to diagnose and act.

Drop your eval questions in the comments and I will answer in future posts.

Share this with your teammates!

See you tomorrow.

## part 8 
How to build great evals - part 8.

The discriminatory property of evals.
A hill-climbing eval is useful when it can separate AI systems that are meaningfully different.

Imagine you run an eval on five AI systems:

A: 94
B: 93
C: 95
D: 94
E: 92

Now suppose you already know A and C are substantially better systems than D and E.

The eval is bad cos it doesn’t tell you that. It has low discriminatory power.

It’s like giving a fifth-grade math test to a group of PhDs - everyone aces it and  you’ve learned nothing about who is the smartest.

That doesn’t mean making evals arbitrarily hard. Then everyone fails and you’re not measuring what your systems are meant for.

The sweet spot for an eval is:
Realistic + difficult + sensitive to differences in capability.

Over time, your good evals will saturate as your harness and underlying models improve. What do you do then?

Drop your guesses in the comments.

Share this with your teammates.

## part 9 
How to build great evals — Part 9

The Eval Roadmap Problem

Most evals fail because teams treat them as static artifacts while their users  expectations and behaviors have evolved.

Your evals need a roadmap that evolves with your product and actual usage patterns.

Take a financial research agent. Here is how use cases will evolve over time.

Early user: Summarize this 5-page earnings report.

3 weeks later: review the last 5 earnings reports and explain their growth story.

2 months later: Here are 15 filings, earnings transcripts and research reports. Build an investment thesis.

Eventually: Monitor my stock portfolio and tell send me alerts when something materially changes my thesis.

Each stage requires different capabilities and hence different evals.

Your evals should change with usage patterns:

short-context -> long-context
single-turn QA -> multi-turn
passage citations -> doc and line citations
Simple QA -> complex synthesis
reactive chat -> proactive agent

If your evals are stuck in week 1 while users are in week 3, it will show in your product and churn metrics.

Here’s a practical way to build the roadmap:
1/ Map the dimensions along which usage will evolve (eg # turns, document size, tool use, autonomy, journey coverage).
2/ Prioritize the use cases and dimensions that matter most for your product.
3/ Talk to your users, mine production traces to look for shifts.
4/ Build P0 evals for the next stage of usage.
5/ Run the evals, find failure modes (remember the taxonomy from Part 3), and hill-climb (from part 6).

The goal is to stay ahead of usage patterns. PM 101.

Drop your questions and I will address in future posts.

Share this with your teammates who think your evals are perfect.

## part 10 
How to build great evals - part 10

Measure the steps, not just the result.

Much like high school math, it isn’t sufficient just to get the right answer, the steps to get there are critical.

Two agent trajectories might produce the same answer (42!!).

but one of them  searches the right sources, retrieves the right document, makes 4 clean tool calls and calculates the result. The other makes 17 calls, searches the same thing 3 times, recovers from 2 errors and eventually gets there.

It’s clear which one is better.

Here’s what you need to do:
1/ clearly define your whole workflow
2/ define the tasks in each step
3/ think through how you measure each step - separate evals or is it a slice of a bigger eval
4/ define your median and hard tasks - reflect them in your evals

Now any time you look at eval results, study the steps first and the final results next.

