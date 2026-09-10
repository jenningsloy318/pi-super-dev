# Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement

Haoyang Yan^(†)    Min-Le Su^(†)    Hangfan Zhang^(†)    Zhanhao Li^(†)    Chen Zhang    Shao Zhang    Yang Chen    Lei Bai    Shuyue Hu Affiliation: Shanghai Artificial Intelligence Laboratory

###### Abstract

This paper studies autonomous software development, in which LLM-based coding agents transform high-level requirements into complete, functional, and usable software systems without human intervention. We introduce Harness-of-Harness (HoH), a framework that enables coding agents to continually improve software during autonomous development. HoH operates on existing coding-agent harnesses, and organizes their executions into iterative planning–coding–testing loops. To sustain improvement across loops, HoH balances repair with capability growth, scopes development into small and verifiable increments, separates implementation-time testing from independent evaluation, and constrains verifiable outputs rather than prescribing agent workflows. It progressively exposes deliverables, role-specific tools, and skills, encourages reuse rather than recreation, and maintains versioned project histories. On GameCraft-Bench, FrontierSWE, and ProgramBench, three harness–model pairs (Codex with GPT-5.5, OpenCode with DeepSeek-V4-Pro, and Pi with MiniMax-M3), HoH consistently outperforms the corresponding standalone harnesses, achieving an average relative gain of 52.25% and a maximum gain of 82.86% after three iterations. In a multi-day deployment with more than 70 iterations, HoH autonomously develops a first-person-shooter game, featuring a coherent storyline, fully implemented core mechanics, human-playable experience, polished visuals and integrated audio.

![Refer to caption](2609.01481v1/fig_case_fusepoint_trajectory.png)

Figure 1: Across successive iterations by Harness-of-Harness, the resulting First-Person-Shooter game features a coherent storyline, implemented combat, weapon and enemy-interaction systems, player guidance, heads-up display and menu systems, cinematic animation, and polished visual and audio presentation, yielding human-playable experience. The game, development traces, and gameplay videos are available on GitHub.

## 1 Introduction

Software development has become a prominent application of large language models (LLMs) \[[4](#bib.bib8), [36](#bib.bib9)\]. As LLM capabilities have advanced, LLM-based coding agents have progressed from localized assistance, such as function completion \[[22](#bib.bib10), [2](#bib.bib11)\], to increasingly complex tasks, including navigating large codebases and resolving repository-level issues \[[12](#bib.bib16), [39](#bib.bib17), [35](#bib.bib25), [29](#bib.bib7), [25](#bib.bib3)\]. Despite their growing adoption, most coding agents still largely operate under a human-in-the-loop setting (Figure 2a): developers must define tasks, guide intermediate decisions, review generated changes and intervene when failures occur \[[1](#bib.bib4)\]. In this study, we pursue a more ambitious goal: autonomous software development (Figure 2b); given only high-level requirements as human input, coding agents start from scratch and independently transform the requirements into complete, functional, and deployable software systems, without further human guidance or intervention.

Such autonomous development poses a fundamentally longer-horizon problem than conventional agentic coding tasks \[[14](#bib.bib12), [28](#bib.bib40)\]. Building a software system from scratch requires agents not only to generate code snippets, but also to translate high-level requirements into executable plans, coordinate interdependent tasks, design and integrate components, and continuously test and debug the evolving system \[[8](#bib.bib27), [32](#bib.bib28), [35](#bib.bib25)\]. As these interdependent decisions and modifications accumulate, development naturally unfolds over increasingly long trajectories \[[14](#bib.bib12), [28](#bib.bib40)\]. As trajectories grow, agents may lose track of earlier requirements and design decisions, or introduce local fixes that violate constraints elsewhere \[[3](#bib.bib41), [26](#bib.bib31)\]. Failed attempts and suboptimal decisions may accumulate, while new evidence from testing can invalidate earlier assumptions \[[33](#bib.bib30), [24](#bib.bib32), [5](#bib.bib24)\]. Long trajectories can also lead to repetitive cycles of inspection and repair, redundant verification of completed components, or premature declaration of completion despite missing or incorrect functionality \[[3](#bib.bib41), [11](#bib.bib39)\]. Together, these challenges suggest that autonomous software development is not simply a problem of longer execution; the real challenge is sustaining coherent and effective progress over time.

Here, we introduce Harness-of-Harness (HoH), a framework that equips coding agents with *continual improvement* capabilities for autonomous software development. Modern coding agents operate within a harness—the surrounding system that provides tools, manages execution and mediates the LLM’s interaction with the development environment \[[39](#bib.bib17), [35](#bib.bib25), [45](#bib.bib34)\]. HoH builds upon existing harnesses and organizes development into iterative planning–coding–testing loops. At each iteration, the planner synthesizes the high-level requirements and evidence from previous iterations into a development plan. Each plan must both address outstanding problems and deliver a small yet concrete new capability, following the principle of iterative and incremental development \[[13](#bib.bib2)\]. This helps prevent development from collapsing into repetitive local repairs, while the limited scope makes progress easier to verify and reduces the risk of uncontrolled changes. The developer then implements the plan and embeds focused testing throughout implementation, creating immediate feedback around local changes. After passing these tests, a tester independently evaluates the resulting system against both the overall requirements and the development plan, using complementary white-box and black-box tests. The tests are conducted from multiple perspectives, such as functional correctness, completeness, usability, and visual and audio quality (if any). The resulting structured test report is returned to the planner as evidence for the next iteration, closing the loop.

Throughout this process, HoH specifies the artifacts and evidence that agents must deliver, but does not prescribe a rigid workflow for producing them. Each role must return a structured artifact, and outputs that violate the required schema trigger a retry. This constrains verifiable outcomes while preserving agent autonomy over reasoning, tool use and implementation strategy. To maintain continuity without overwhelming the context window, HoH adopts progressive disclosure rather than a dedicated memory module: plans, reports, histories and other artifacts are persisted in the file system and initially exposed through a concise, categorized index, with detailed contents retrieved only when relevant. Tools, such as MCP servers, expert models and domain-specific algorithms, are organized by role, with lightweight Markdown-based skills providing concise, on-demand guidance for their use. Agents are encouraged to draw on existing resources rather than recreate standard capabilities, reducing redundant effort on routine engineering tasks. Finally, HoH maintains a versioned record of project evolution at both the agent role and iteration levels. By preserving the software state together with concise accounts of how it changes, HoH can return to previously verified states after major regressions and draw on evidence from earlier attempts when similar failures recur to inform the diagnosis and resolution.

We evaluate HoH in two complementary settings: three controlled benchmarks (GameCraft-Bench \[[23](#bib.bib1)\], FrontierSWE \[[6](#bib.bib5)\], and ProgramBench \[[40](#bib.bib6)\]), and open-ended game development that spans over multiple days. First, we evaluate the HoH loop under the original benchmark specifications, without additional tools, skills or version-control mechanisms. We consider three harness–model configurations: Codex with GPT-5.5 (high), OpenCode with DeepSeek-V4-Pro, and Pi with MiniMax-M3. Across all three benchmarks, HoH consistently outperforms the corresponding standalone harnesses. After three iterations, it yields absolute gains of 16.62–22.08 points on GameCraft-Bench, 19–29 points on FrontierSWE, and 6.09–16.85 points on ProgramBench. On FrontierSWE, HoH with Codex and GPT-5.5 (high) continues improving over ten iterations, from 22% to 72.67%. In our second setting, HoH autonomously builds a complex game from scratch, given only high-level product requirements, which exposes challenges that are largely absent from conventional benchmarks. Different from benchmark evaluation, we additionally implement HoH with role-specific tools and skills, supporting development engine interaction, asset acquisition and generation, reference retrieval, testing, and project-state management. Code changes and role-specific artifacts are committed to a public GitHub repository after each agent stage, making the complete development trajectory traceable. Over multiple days of autonomous development, HoH transforms the initial requirements into a complete, human-playable game with a coherent storyline, fully implemented core mechanics, polished visuals and integrated audio.

![Refer to caption](2609.01481v1/fig_intro_human_vs_automated_loop.png)

Figure 2: Two different modes of software development. In human-in-the-loop development, coding agents generate code under continuous human oversight, guidance, review, and intervention. In autonomous software development, agents independently transform high-level requirements into complete, functional, and deployable software systems without human guidance or intervention.

## 2 Related Work

##### Agent Harnesses.

An agent harness is the operational layer that determines what information an LLM receives, what actions it can execute, and how execution results enter subsequent decisions \[[16](#bib.bib20), [17](#bib.bib22)\]. Many mechanisms now assembled within harnesses were developed as distinct research directions. Prompting and context engineering shape model-facing state \[[19](#bib.bib19), [46](#bib.bib35)\]; external memory extends the state available across interactions \[[30](#bib.bib21)\]; ReAct couples reasoning with environment actions \[[41](#bib.bib18)\]; and GPTSwarm represents multi-agent orchestration as an optimizable graph \[[50](#bib.bib23)\]. More recent work treats the harness itself as the optimization target: AutoHarness synthesizes a code harness from environment feedback, Meta-Harness searches over harness code, and Self-Harness iteratively diagnoses and modifies its own harness \[[20](#bib.bib36), [15](#bib.bib33), [45](#bib.bib34)\]. These approaches improve agent behavior by changing the operational layer. HoH builds on existing agent harnesses and iteratively improves an evolving software project through repeated implementation, evaluation, and refinement.

##### Agentic Systems for Software Development.

Research has progressed from localized code generation and self-contained programs \[[4](#bib.bib8), [10](#bib.bib29)\] to repository-level issue resolution, agent–computer interfaces, general software-engineering agents, and refactoring \[[12](#bib.bib16), [39](#bib.bib17), [38](#bib.bib26), [35](#bib.bib25), [29](#bib.bib7)\]. Beyond repository issue resolution, MetaGPT and ChatDev use predefined role-based workflows for software generation \[[8](#bib.bib27), [32](#bib.bib28)\]; AgileCoder and EvoDev organize incremental development around sprints or dependent features \[[27](#bib.bib37), [18](#bib.bib38)\]; and EvoMAC adapts the multi-agent workflow using test feedback \[[9](#bib.bib13)\]. Recent benchmarks broaden both the development settings and the capabilities under evaluation \[[14](#bib.bib12), [28](#bib.bib40), [7](#bib.bib47)\]. SWE-EVO and SlopCodeBench study long-horizon evolution and degradation, while Commit0, ProjDevBench, ProgramBench, and GameCraft-Bench evaluate from-scratch construction of complete libraries or projects \[[49](#bib.bib14), [21](#bib.bib15), [40](#bib.bib6), [23](#bib.bib1)\]. FrontierSWE further covers from-scratch implementation together with open-ended performance and research objectives \[[6](#bib.bib5)\]. Existing coding harnesses typically organize development within a bounded episode, providing limited support for preserving project decisions, verified functionality, and evaluation evidence across subsequent revisions. HoH builds on these harnesses and extends their use to iterative greenfield development by maintaining continuity across planning, implementation, and evaluation cycles.

## 3 Harness-of-Harness

Harness-of-Harness (HoH) organizes a fixed coding-agent system into a long-running cycle of planning, development, and independent testing. Each cycle produces a bounded software increment, verifies the resulting candidate, and carries both the candidate and its execution evidence into the next cycle. The design follows iterative and incremental software development: the system grows through small, testable changes while preserving behavior that has already been validated.

![Refer to caption](2609.01481v1/fig_method_hoh_framework.png)

Figure 3: Harness-of-Harness overview. HoH repeatedly invokes a *Project Planner*, *Developer*, and *QA Tester* around an evolving software artifact. The deterministic Runtime freezes each role’s inputs, enforces its permissions, binds evidence to the tested candidate, and records the resulting project state. The model, base harness, role definitions, and runtime policy remain fixed within a run; the development document, software artifact, and execution evidence evolve across iterations.

### 3.1 Problem Formulation and Challenges

Given a software specification $\mathcal{S}$, the end-to-end software development task is to construct a complete software artifact $A$ that satisfies its functional and quality requirements. Let $M$ denote a language model and $H$ the coding harness through which it interacts with a software environment. HoH applies a fixed harness–model configuration to this task:

|     |                                               |     |     |
|-----|-----------------------------------------------|-----|-----|
|     | $${{HoH}_{M,H}:{\mathcal{S}\longmapsto A}}.$$ |     | (1) |

This setting presents three challenges. (1) As the artifact evolves over a long development trajectory, earlier requirements, design decisions, observed failures, and previously validated behavior can be forgotten or become disconnected from subsequent changes. (2) A high-level specification often leaves the next useful change underdetermined. Component dependencies and evolving implementation constraints mean that locally reasonable changes can conflict with existing behavior, while repeated inspection and repair may consume iterations without advancing the complete system. (3) Functional and quality requirements manifest through heterogeneous, scenario-specific behaviors. Missing or incorrect behavior may therefore remain undetected, allowing an incomplete artifact to be accepted as complete. To address these challenges, HoH organizes planning, implementation, and independent verification into a three-agent loop that is repeated across iterations, with the evolving artifact and accumulated development evidence carried between loops.

### 3.2 Harness-of-Harness Overview

In end-to-end software development, the next useful change cannot be determined from the specification alone; it requires jointly interpreting the high-level specification, the current artifact, and the evidence accumulated during development. The artifact exposes component dependencies, implementation constraints, and missing capabilities. Execution evidence reveals observed failures, changes the priority of unmet requirements, and identifies validated behavior that subsequent work should preserve.

HoH organizes this changing decision process around a bounded development loop. Each loop starts from the current project state and selects one coherent objective that groups the interdependent work needed for an observable software increment while excluding unrelated changes. It then implements the increment and evaluates the resulting artifact before further development begins. Evaluation results inform the next objective by revealing unmet requirements and observed failures, while identifying validated behavior that subsequent changes should preserve. Repeating this unit allows repair, extension, and preservation demands to be reprioritized as the artifact evolves, keeping local work aligned with the end-to-end objective.

Producing a validated increment requires three different decisions. The system must first determine what to change next from the specification and retained project state. The second decision concerns how to realize that change in the current artifact, where the appropriate implementation depends on details encountered during development. The final decision is whether the resulting behavior satisfies observable requirements. These decisions require different context and authority: objective selection requires a project-level view, implementation requires write access and local technical autonomy, and acceptance requires an assessment that is independent of the implementation claim. HoH assigns these responsibilities to a *Project Planner*, a *Developer*, and a *QA Tester*, respectively. Each loop invokes the same harness–model configuration once in each role, in planning–development–testing order.

### 3.3 Cross-Loop State Management

Repeated loops support iterative and incremental development only when a later loop inherits more than the latest implementation. A software artifact records the code, resources, and configuration that currently exist, but it does not fully record why earlier changes were selected, which observed failures remain unresolved, or which behavior has already been validated. Since each harness invocation has bounded context, information retained only in its interaction history disappears when the invocation ends. A later loop that receives only the code must reconstruct the development state from the implementation. This reconstruction can overlook unmet requirements, repeat work whose outcome is already known, forget unresolved failures, or regress validated behavior.

HoH therefore maintains two complementary states across loop boundaries. The artifact state carries the current implementation from one loop to the next. The evidence state carries the validated knowledge needed to decide how that implementation should change. Together, they preserve both the object under development and the information accumulated by developing and evaluating it.

Let $A_{t}$ denote the software artifact state after loop $t$, including its source code, configuration, resources, and project metadata. It records what the software currently is and provides the concrete starting point for the next increment. Let $\mathcal{E}_{t}$ denote the execution evidence state obtained by evaluating $A_{t}$ against the specification and the current development objective. It records which behaviors have been verified, which claims remain unsupported, and which observed failures require further work. Neither state subsumes the other: $A_{t}$ supplies the implementation on which development operates, whereas $\mathcal{E}_{t}$ supplies the validated project knowledge used to direct that development.

Let $A_{0}$ denote the empty project workspace before the first loop. With $\mathcal{E}_{0} = \varnothing$, the transition across loop $t$ can be summarized as

|     |                                                                                                                                                                                          |     |     |
|-----|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----|-----|
|     | $${\left( A_{t - 1},\mathcal{E}_{t - 1} \right)\overset{\text{loop~}\hspace{0pt}t\hspace{0pt}\text{~under~}\hspace{0pt}\mathcal{S}}{\rightarrow}\left( A_{t},\mathcal{E}_{t} \right)}.$$ |     | (2) |

The two states enter a loop in different ways. The Project Planner combines the fixed specification $\mathcal{S}$ with $\mathcal{E}_{t - 1}$ to determine the next bounded increment. It also reads $A_{t - 1}$ as implementation context so that the selected work is grounded in the current project. The Developer then starts from $A_{t - 1}$ and realizes the increment, producing $A_{t}$. The QA Tester evaluates this updated artifact and produces $\mathcal{E}_{t}$ for the next planning decision.

At the loop boundary, $(A_{t},\mathcal{E}_{t})$ becomes the starting state of loop $t + 1$. Carrying $A_{t}$ forward allows implementation work to accumulate instead of being reconstructed in every loop. Interpreting $\mathcal{E}_{t}$ under $\mathcal{S}$ allows new observations to revise development priorities, unresolved gaps to remain visible, and validated behavior to become a preservation requirement. The next objective can therefore build on prior progress without reconstructing the project trajectory from the artifact alone. Artifact continuity makes development incremental, and evidence-guided objective selection makes it iterative.

### 3.4 Implementation of a HoH Loop

A HoH loop converts retained project state into a coherent software increment whose behavior is independently assessed. This transformation begins with objective selection. The global specification and prior evidence may identify many interdependent demands, so the loop needs a project-level decision about which bounded, locally complete subset should be addressed next. Establishing this scope before artifact modification gives the increment observable completion conditions and separates it from unrelated work.

Realizing the selected objective is a different function. The current artifact exposes implementation-specific choices that cannot be fully determined during planning, so artifact modification requires write authority and autonomy over local technical decisions. Assessing the result introduces a third function. The implementing agent has direct knowledge of its changes, but its completion claim cannot establish that the intended behavior is present. Acceptance must instead be determined from observations of a fixed candidate by a role that did not produce that candidate.

These functions differ in the information they require, the authority they exercise, and the deliverable they produce. HoH therefore assigns objective selection to a Project Planner, artifact modification to a Developer, and independent acceptance to a QA Tester. The separation makes the target of an increment explicit, preserves implementation autonomy within that target, and prevents implementation and acceptance from collapsing into the same decision.

HoH instantiates the three roles as separate invocations of the same fixed harness–model configuration. For each invocation, a role-specific prompt specifies the role’s responsibility, while a deterministic Runtime contract enforces its execution authority. The prompt combines fixed role instructions with loop-specific context to state the role’s objective and required structured output, without prescribing its reasoning process or tool sequence.

The Runtime controls which inputs an invocation can access, which tools and write operations it may use, and which output schema it must satisfy. HoH thus constrains what each role may read, change, and deliver while leaving the agent free to determine how to complete its assigned work within those boundaries.

#### 3.4.1 Project Planning

The global specification may describe capabilities whose implementation spans interdependent components, while the retained project state adds observed failures, unmet requirements, and behaviors that must be preserved. These demands describe what remains relevant to the project, but they do not by themselves define a tractable unit of work for one loop. Selecting an isolated task can omit dependencies needed for observable behavior, whereas combining too many unrelated demands enlarges the change surface. When the resulting candidate fails, the source of the failure becomes harder to localize, and the affected behavior becomes harder to verify.

The Project Planner converts these competing demands into one bounded objective. It reconciles $\mathcal{S}$ with $\mathcal{E}_{t - 1}$ to determine what should be addressed next and what previously validated behavior must be preserved. It reads $A_{t - 1}$ as implementation context so that the objective reflects the current project structure, but it cannot modify the artifact. The result is a development document $D_{t}$ that defines the scope and validation conditions of the current increment.

The objective is bounded but locally complete. Boundedness limits the amount of unrelated behavior changed in one loop, which keeps implementation and diagnosis tractable. Local completeness ensures that the selected capability includes the related changes required to make it functional and testable. The scope of an increment is therefore determined by a coherent observable behavior, not simply by the number of files or components it touches.

Accordingly, $D_{t}$ contains a small set of related tasks, the functionality that must be preserved, and observable requirements for validating the increment. Related changes may span several files or components when they are jointly required by the objective. Unrelated refactoring and opportunistic feature expansion remain outside the loop. The document specifies expected behavior and validation conditions, while leaving the Developer to choose its reasoning process, tools, and implementation algorithm.

#### 3.4.2 Artifact Development

A development document defines the intended behavior of an increment, but it cannot anticipate every implementation decision exposed by the evolving artifact. The Developer must interpret $D_{t}$ in the context of the existing project and adapt its implementation as it encounters code structure, dependencies, and runtime behavior. HoH therefore constrains the Developer by the required outcome and artifact boundary instead of prescribing its internal procedure. Within these constraints, the Developer remains free to select the concrete design, tools, and debugging strategy appropriate to the current artifact.

Artifact development follows a single-writer boundary: only the Developer may modify the evolving artifact. The Developer warm-starts from $A_{t - 1}$ so that each increment extends the current implementation and retains the surrounding project structure. The Planner may inspect $A_{t - 1}$ to ground the objective, and the QA Tester may inspect and execute the resulting candidate, but neither may alter the artifact. This boundary makes responsibility for the transition from $A_{t - 1}$ to $A_{t}$ explicit and keeps the candidate lineage unambiguous. Once the authorized modifications are complete, the updated project becomes $A_{t}$.

Testing is also integrated into artifact development so that failures are exposed close to the changes that cause them. Before editing, the Developer establishes a baseline for the target behavior. After each meaningful change, it reruns the corresponding path and inspects the affected implementation, execution results, and adjacent regression surface. This baseline–change–retest cycle follows the software-engineering principle commonly known as *shift-left testing*. Shortening the distance between a change and its test makes local diagnosis and correction more tractable.

Developer testing and independent acceptance answer different questions. The Developer uses self-tests to determine whether the implementation is ready to be presented as a candidate and to repair failures encountered during its own work. These tests do not establish that the product requirements have been satisfied. Developer observations and completion claims therefore remain inputs to subsequent verification; acceptance is reserved for the independent QA stage.

#### 3.4.3 Independent Quality Assurance

Independent QA determines whether the candidate exhibits the behavior required by the current objective while preserving relevant existing functionality. End-to-end software quality is multidimensional and cannot generally be reduced to one fixed performance metric. The relevant functional behavior, interaction flows, configuration, resources, and regression risks depend on both the global specification and the selected increment. HoH therefore derives scenario-specific, checkable evaluation criteria from $\mathcal{S}$ and $D_{t}$ rather than applying the same generic test to every candidate.

The QA Tester receives $A_{t}$ as a frozen, read-only candidate together with the results of deterministic build and execution checks. Freezing separates artifact production from artifact assessment: the implementation cannot change while its evidence is being collected. It also gives every observation a single candidate identity, so that an assessment cannot combine behavior from different artifact versions. Read-only access prevents the QA stage from silently repairing the candidate it is meant to evaluate.

For each criterion, the QA Tester selects observations appropriate to the software scenario. Black-box tests exercise the candidate through ordinary inputs and rendered outputs to examine user-observable behavior, state transitions, and end-to-end flows. These observations establish whether the required behavior is visible at the product boundary. White-box tests inspect the source, configuration, resource bindings, runtime state, and logs. They help diagnose failures and corroborate observations whose internal conditions cannot be determined from outputs alone.

The two forms of testing provide complementary views of the same frozen candidate. A criterion is verified only when candidate-bound records support the required behavior. Observed failures, unmet requirements, regressions, and insufficient evidence are recorded as gaps instead of being inferred as successful completion. The resulting assessments and supporting execution records form the evidence state $\mathcal{E}_{t}$ passed to the next loop. This separation ensures that acceptance follows observable evidence rather than the Developer’s knowledge of its implementation or its completion claim.

The complete HoH procedure is summarized in Algorithm [1](#alg1 "Algorithm 1 ‣ 3.4.3 Independent Quality Assurance ‣ 3.4 Implementation of a HoH Loop ‣ 3 Harness-of-Harness ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), which combines the cross-loop state transition with project planning, artifact development, independent quality assurance, and Runtime validation.

Input: specification $\mathcal{S}$, initial artifact $A_{0}$, iteration budget $T$  
Fixed: model $M$, harness $H$, and role contracts  
Output: final artifact $A_{T}$

1:  $\mathcal{E}_{0}\leftarrow\varnothing$

2:  for ${t = 1},\ldots,T$ do

3:   $D_{t}\leftarrow{{ProjectPlanner}{(\mathcal{S},\mathcal{E}_{t - 1},{{{read}\hspace{0pt}\_\hspace{0pt}{only}}{(A_{t - 1})}})}}$

4:   $A_{t}\leftarrow{{Developer}{(A_{t - 1},\mathcal{S},D_{t})}}$

5:   $\mathcal{E}_{t}\leftarrow{{QATester}{({{{read}\hspace{0pt}\_\hspace{0pt}{only}}{(A_{t})}},\mathcal{S},D_{t},{{{Runtime}.{check}}{(A_{t})}})}}$

6:  end for

7:  return $A_{T}$

Algorithm 1 Harness-of-Harness

## 4 Experiments: Benchmark Evaluation

We evaluate HoH on three software-development benchmarks and three harness–model configurations, comparing final artifact quality with the corresponding Vanilla baselines.

### 4.1 Experimental Setup

##### Benchmarks.

We evaluate HoH on three benchmarks: GameCraft-Bench \[[23](#bib.bib1)\], FrontierSWE \[[6](#bib.bib5)\], and ProgramBench \[[40](#bib.bib6)\]. GameCraft-Bench comprises 140 tasks across 15 game families, each requiring an agent to construct a complete, playable Godot project from a natural-language specification. We sample 45 tasks using stratified random sampling by game family, selecting three tasks from each of the 15 families with a fixed random seed. For coarse-grained analysis, we additionally organize the 15 families into five broader groups defined in this work: Action, Timing, Strategy, Simulation, and Adventure. The complete sampled task list and our family-to-group mapping are provided in the supplementary material. Due to computational resource constraints, we select $15$ tasks from FrontierSWE’s $17$ tasks for evaluation, comprising $4$ Implementation (Impl.), $9$ Performance (Perf.), and $2$ Research tasks. ProgramBench is a cleanroom program-reconstruction benchmark in which agents receive only a compiled executable and documentation and must rebuild a codebase whose behavior matches the reference program. More details are provided in the supplementary material.

##### Harnesses and Models.

We evaluate HoH with three harness--model configurations: Codex CLI¹¹ 1 [https://github.com/openai/codex](https://github.com/openai/codex); version 0.142.5. with GPT-5.5 at high reasoning effort, OpenCode²² 2 [https://github.com/anomalyco/opencode](https://github.com/anomalyco/opencode); version 1.14.30. with DeepSeek-V4-Pro, and Pi Coding Agent³³ 3 [https://github.com/earendil-works/pi](https://github.com/earendil-works/pi); version 0.80.10. with MiniMax-M3.

##### Baseline and Evaluation Protocol.

We compare HoH against *Vanilla*, the corresponding harness–model configuration without the HoH protocol. Vanilla performs one standard development pass, whereas *HoH@$T$* performs $T$ planning–coding–testing iterations, with the software artifact and execution evidence carried across iterations; the main experiments use $T = 3$. Intermediate and final HoH artifacts are evaluated only after the complete run, and evaluator outputs are not returned to the development loop. For each task, Vanilla and HoH use identical benchmark-provided initial states and the same underlying harness–model configuration, differing only in the application of the HoH protocol.

##### Metrics.

For GameCraft-Bench, we report the benchmark’s *Overall* score. Under this metric, game artifacts that fail to compile or run receive a score of zero, while runnable artifacts are scored by combining Core Mechanics, Content Depth, Functional Visuals, and Art and Presentation using the benchmark-defined weights. We average task-level scores over the 45 tasks and use the benchmark’s 0–100 scale. For FrontierSWE, task-specific verifiers assign official rewards, and we report the mean reward over the 15 evaluated tasks. We additionally report the official dominance score, defined as the average task-level win rate against a randomly selected competing configuration from the 12 evaluated harness–condition combinations. For ProgramBench, we report *Avg. Test Pass Rate*, computed as the mean across tasks of the fraction of hidden behavioral tests passed for each task. We use this continuous signal for relative comparisons between Vanilla and HoH and abbreviate it as *Pass Rate^($\dagger$)* in Table [1](#S4.T1 "Table 1 ‣ 4.2 Main Results ‣ 4 Experiments: Benchmark Evaluation ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"). As a proxy for model-interaction volume, we report provider-reported cumulative input and output tokens from coding-harness model calls, excluding benchmark evaluation. Input totals may include cached context reads; because cache accounting differs across providers, we use these values for within-configuration comparisons rather than direct cross-provider cost comparisons.

### 4.2 Main Results

|                               |                 |         |         |         |         |                  |             |        |          |             |                       |
|-------------------------------|-----------------|---------|---------|---------|---------|------------------|-------------|--------|----------|-------------|-----------------------|
|  Setting                      | GameCraft-Bench |         |         |         |         |                  | FrontierSWE |        |          |             | ProgramBench          |
|                               | Action          | Timing  | Strat.  | Sim.    | Adv.    | Overall          | Impl.       | Perf.  | Research | Dominance   | Pass Rate^($\dagger$) |
|    Codex + GPT-5.5 (high)     |                 |         |         |         |         |                  |             |        |          |             |                       |
|  Vanilla                      |  48.74          |  48.80  |  44.06  |  53.63  |  52.68  |  49.58           |  0.21       |  0.17  |  1.15    |  44%        |  60.41                |
|  HoH@1                        |  59.73          |  53.79  |  57.01  |  66.75  |  61.24  |  59.71           |  0.24       |  0.44  |  1.30    |  58%        |  65.42                |
|  HoH@2                        |  64.34          |  62.03  |  59.97  |  71.77  |  66.11  |  64.84           |  0.28       |  0.45  |  1.18    |  60%        |  65.79                |
|  HoH@3                        |  71.02          |  70.26  |  66.13  |  78.42  |  71.76  |  71.52 (+21.93)  |  0.30       |  0.45  |  1.45    |  71% (+27)  |  66.50 (+6.09)        |
|    OpenCode + DeepSeek-V4-Pro |                 |         |         |         |         |                  |             |        |          |             |                       |
|  Vanilla                      |  26.21          |  24.05  |  21.27  |  37.12  |  25.84  |  26.90           |  0.08       |  0.23  |  0.57    |  25%        |  45.27                |
|  HoH@1                        |  27.75          |  27.40  |  21.73  |  43.75  |  22.44  |  28.61           |  0.09       |  0.23  |  0.78    |  28%        |  55.33                |
|  HoH@2                        |  43.22          |  36.56  |  33.51  |  52.26  |  36.05  |  40.32           |  0.10       |  0.27  |  0.78    |  42%        |  55.66                |
|  HoH@3                        |  49.00          |  45.05  |  43.34  |  55.86  |  51.64  |  48.98 (+22.08)  |  0.15       |  0.27  |  0.78    |  44% (+19)  |  57.56 (+12.29)       |
|    Pi + MiniMax-M3            |                 |         |         |         |         |                  |             |        |          |             |                       |
|  Vanilla                      |  45.64          |  38.20  |  34.53  |  48.19  |  44.26  |  42.16           |  0.06       |  0.12  |  1.30    |  35%        |  35.83                |
|  HoH@1                        |  50.59          |  52.23  |  38.60  |  54.00  |  49.89  |  49.06           |  0.10       |  0.42  |  1.89    |  62%        |  48.68                |
|  HoH@2                        |  54.70          |  56.52  |  42.33  |  63.20  |  58.47  |  55.04           |  0.11       |  0.43  |  1.89    |  66%        |  53.57                |
|  HoH@3                        |  58.24          |  62.10  |  44.86  |  64.25  |  64.44  |  58.78 (+16.62)  |  0.11       |  0.45  |  1.88    |  64% (+29)  |  52.68 (+16.85)       |

Table 1: Main results on GameCraft-Bench, FrontierSWE, and ProgramBench. Each harness is evaluated under Vanilla and HoH@1–3. Within each harness and metric, bold values mark the best setting; rankings use unrounded values, and exact ties share the same formatting. Small green values shown only for HoH@3 give absolute gains over Vanilla; Dominance gains are percentage points. Bold italic labels distinguish aggregate metrics from task categories. Strat., Sim., Adv., Impl., and Perf. denote Strategy, Simulation, Adventure, Implementation, and Performance, respectively. FrontierSWE reports category scores and Dominance. For ProgramBench, *Pass Rate*^($\dagger$) denotes the benchmark’s *Avg. Test Pass Rate*.

##### HoH improves software artifact quality across three benchmarks spanning game development, repository-level software engineering, and program reconstruction.

Table [1](#S4.T1 "Table 1 ‣ 4.2 Main Results ‣ 4 Experiments: Benchmark Evaluation ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") reports Vanilla and all three HoH iterations for each harness–model configuration. HoH@3 outperforms Vanilla across the three benchmarks under all three configurations. On GameCraft-Bench, mean Overall scores increase from 49.58 to 71.52 for Codex, from 26.90 to 48.98 for OpenCode, and from 42.16 to 58.78 for Pi. On FrontierSWE, rewards increase from 0.31 to 0.54, from 0.23 to 0.31, and from 0.26 to 0.55, respectively. On ProgramBench, *Avg. Test Pass Rate* increases from 60.41 to 66.50 for Codex, from 45.27 to 57.56 for OpenCode, and from 35.83 to 52.68 for Pi. HoH@3 also outperforms Vanilla in every reported task category across the three benchmarks under all three configurations.

##### HoH yields consistent gains over Vanilla across all three harness–model pairs.

The gains are not limited to configurations with a particular level of Vanilla performance. Codex with GPT-5.5 (high), the strongest Vanilla configuration, reaches the highest final GameCraft-Bench score of 71.52 after improving by 21.93 points. Pi with MiniMax-M3 records the largest gain on FrontierSWE, increasing by 0.29 from 0.26 to 0.55, and the largest ProgramBench gain, increasing the average test pass rate by 16.85 points. OpenCode with DeepSeek-V4-Pro starts from the lowest Vanilla score on GameCraft-Bench and FrontierSWE, yet HoH@3 raises its scores to 48.98 and 0.31, respectively, while increasing its ProgramBench average test pass rate from 45.27 to 57.56. OpenCode with HoH@3 further exceeds Codex Vanilla in Action and Simulation on GameCraft-Bench and in Performance on FrontierSWE. Thus, HoH improves configurations that begin at substantially different levels of Vanilla performance.

##### HoH continues to improve software artifact quality as development loops progress.

Table [1](#S4.T1 "Table 1 ‣ 4.2 Main Results ‣ 4 Experiments: Benchmark Evaluation ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") traces the gains accumulated over the first three development loops. On GameCraft-Bench, *Overall* scores increase monotonically from HoH@1 to HoH@3 under all three harness–model pairs. This trend is particularly pronounced for OpenCode, whose gain over Vanilla grows from 1.71 points at HoH@1 to 13.42 at HoH@2 and 22.08 at HoH@3. On FrontierSWE, the cross-configuration *Dominance* of Codex increases from 44% under Vanilla to 58%, 60%, and 71% at HoH@1–3, respectively. ProgramBench exhibits a similar overall pattern: Codex and OpenCode attain their highest *Pass Rates* at HoH@3, while Pi peaks at HoH@2.

### 4.3 Analysis and Ablation Study

##### On GameCraft-Bench, HoH improves software quality across mechanics, content, visuals, and presentation.

Figure [4](#S4.F4 "Figure 4 ‣ On GameCraft-Bench, HoH improves software quality across mechanics, content, visuals, and presentation. ‣ 4.3 Analysis and Ablation Study ‣ 4 Experiments: Benchmark Evaluation ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") reports the four benchmark-defined GameCraft-Bench quality components separately. HoH@3 improves all four components under every harness–model configuration, with gains of 20.00–25.56 points for Codex, 19.25–34.63 points for OpenCode, and 11.32–25.38 points for Pi. For Codex, Functional Visuals shows the largest increase, from 48.67 to 74.23, while Art and Presentation rises from 45.28 to 65.28. The improvements therefore span gameplay mechanics, content richness, visual clarity, and presentation quality.

Figure 4: Vanilla and HoH@3 scores across the four GameCraft-Bench rubric categories. Panels (a)–(c) show results for Codex with GPT-5.5 (high), OpenCode with DeepSeek-V4-Pro, and Pi with MiniMax-M3, respectively. Bars report mean category scores over 45 tasks for Core Mechanics, Content Depth, Functional Visuals, and Art and Presentation; error bars indicate 95% bootstrap confidence intervals.

Figure 5: FrontierSWE Dominance over 10 loops. Shading shows $\pm 1$ SE; the star marks the best checkpoint and the dashed line denotes Vanilla baseline.

##### On FrontierSWE, HoH sustains quality gains over ten loops.

To examine whether these gains extend beyond three loops, we continue running Codex with GPT-5.5 (high) through HoH@10 on the same 15 FrontierSWE tasks and report *Dominance* over a fixed 11-checkpoint comparison pool comprising Vanilla and HoH@1–10.

As shown in Figure [5](#S4.F5 "Figure 5 ‣ On GameCraft-Bench, HoH improves software quality across mechanics, content, visuals, and presentation. ‣ 4.3 Analysis and Ablation Study ‣ 4 Experiments: Benchmark Evaluation ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), *Dominance* increases from 39.33% at HoH@3 to 72.67% at HoH@10 and reaches 76.00% at HoH@9, whereas Vanilla obtains 27.33%. HoH@10 therefore improves upon HoH@3 by a further 33.34 percentage points and exceeds Vanilla by 45.34 points.

![Refer to caption](2609.01481v1/fig_results_gamecraft_examples.png)

Figure 6: Qualitative comparison of final game artifacts produced by Vanilla and HoH@3 using Codex with GPT-5.5 (high). Columns show three GameCraft-Bench tasks from distinct game families: Momentum Lab (momentum-based platformer), Kitchen Rush (restaurant-management simulation), and Ant Empire (idle colony-management game). Rows show gameplay frames from Vanilla (top) and HoH@3 (bottom). Numbered dashed boxes identify the regions discussed in the annotations; red crosses and green checks denote limitations and implemented functionality, respectively.

##### For the same number of development passes, HoH consistently outperforms the Vanilla baseline.

To distinguish the contribution of HoH from the effect of running the coding agent for more passes, we compare it with Vanilla Continuation using Codex with GPT-5.5 (high). Vanilla uses the official harness configuration with the same model and inference settings as HoH. After each pass, Vanilla Continuation submits an additional iteration prompt to continue the same session for another development pass. Table [2](#S4.T2 "Table 2 ‣ For the same number of development passes, HoH consistently outperforms the Vanilla baseline. ‣ 4.3 Analysis and Ablation Study ‣ 4 Experiments: Benchmark Evaluation ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") reports the resulting pass-controlled comparison.

| Method               | Dev. Passes | Score | Tokens ($M$) |
|----------------------|-------------|-------|--------------|
| Vanilla              | 1           | 49.58 | 2.59         |
| Vanilla Continuation | 2           | 54.99 | 4.56         |
| Vanilla Continuation | 3           | 58.24 | 6.33         |
| HoH                  | 1           | 59.71 | 2.88         |
| HoH                  | 2           | 64.84 | 5.67         |
| HoH                  | 3           | 71.52 | 8.41         |

Table 2: Comparison of HoH and repeated Vanilla development after 1, 2, and 3 development passes on GameCraft-Bench. Results use Codex with GPT-5.5 (high). Score denotes the mean GameCraft-Bench Overall score over 45 tasks, and tokens are mean cumulative coding-harness tokens per task.

At matched budgets of one, two, and three development passes, HoH achieves scores of 59.71, 64.84, and 71.52, compared with 49.58, 54.99, and 58.24 for Vanilla, corresponding to gains of 10.13, 9.85, and 13.28 points. The advantage is not explained by greater token use alone: HoH@2 achieves 64.84 with 5.67M tokens, exceeding the 58.24 obtained by three-pass Vanilla Continuation with 6.33M tokens. HoH therefore produces higher-quality artifacts than repeated Vanilla development under the same pass budget and a comparable inference budget. Further details of the pass-controlled experimental design and complete results are provided in the supplementary material.

##### Qualitative Analysis.

On GameCraft-Bench, HoH produces more complete and refined game artifacts, with richer gameplay mechanics, clearer visual presentation, and deeper progression. Figure [6](#S4.F6 "Figure 6 ‣ On FrontierSWE, HoH sustains quality gains over ten loops. ‣ 4.3 Analysis and Ablation Study ‣ 4 Experiments: Benchmark Evaluation ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") compares gameplay frames from Vanilla and HoH@3 for three tasks from distinct game families.

In Momentum Lab, themed terrain and visual cues make the objective and wall-jump route explicit. In Kitchen Rush, distinct pickup, preparation, plating, and disposal stations form a complete and legible restaurant workflow. In Ant Empire, specialist caste counts, seasonal state, and outcome state expose longer-term colony progression. The corresponding *Overall* scores increase from 34.05 to 70.61, from 42.63 to 73.38, and from 65.52 to 87.88, respectively.

| Variant               | Score            | Tokens ($M$) |
|-----------------------|------------------|--------------|
| w/o Plan Update       | 63.39 ($- 8.13$) | 7.56         |
| w/o Evidence Feedback | 65.23 ($- 6.28$) | 7.46         |
| w/o Warm-Start        | 63.67 ($- 7.85$) | 11.12        |
| Full HoH@3            | 71.52            | 8.41         |

Table 3: GameCraft-Bench ablation study with Codex and GPT-5.5 (high). Parentheses show score differences from Full HoH@3; tokens are mean cumulative totals per task.

##### Ablation Study.

To assess the role of HoH’s cross-iteration mechanisms, we evaluate three variants on all 45 GameCraft-Bench tasks using Codex with GPT-5.5 (high), with $T = 3$ for each variant. w/o Plan Update freezes the first development document for subsequent iterations ($D_{t} = D_{1}$ for $t \geq 2$), whereas w/o Evidence Feedback replans without the preceding execution evidence. Both retain artifact warm-start. w/o Warm-Start retains evidence-conditioned planning but rebuilds the artifact from the empty initial workspace $A_{0}$ in every iteration.

As shown in Table [3](#S4.T3 "Table 3 ‣ Qualitative Analysis. ‣ 4.3 Analysis and Ablation Study ‣ 4 Experiments: Benchmark Evaluation ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), all three variants underperform Full HoH@3 on every task. Removing plan updates, excluding execution evidence from replanning, and removing warm-start lowers the score by 8.13, 6.28, and 7.85 points, respectively. Without warm-start, token usage also increases from 8.41M to 11.12M per task because of repeated reconstruction. These results show that later HoH iterations benefit from both revising the development document with execution evidence and continuing from the preceding implementation. Detailed ablation protocols and complete per-task results are provided in the supplementary material.

## 5 Experiments: Multi-Day Autonomous FPS Game Development

Benchmark evaluations measure artifact quality after a small number of development loops. A multi-day case study examines a complementary property: whether a fixed harness–model configuration can maintain coherent project evolution as implementation constraints, validated behavior, and observed failures accumulate over many loops. We study this property through Fusepoint, a single-player narrative first-person shooter developed from an empty workspace containing only a user-provided product requirements document (PRD). The case analyzes whether HoH can sustain incremental progress over 70 loops as implementation constraints, validated behavior, and observed failures accumulate.

### 5.1 Case Design and Autonomy Boundary

##### Task and Autonomy Boundary.

Fusepoint provides a demanding end-to-end development case. The product contract specifies a five-minute, single-player bomb-defusal mission. It requires the ordered capture of two control points, a three-stage defusal at the final objective, a fixed roster of 18 enemies distributed as 3, 5, and 10 across the three encounter regions, and distinct success and detonation branches. Satisfying these requirements depends on integrating a 3D environment and external assets with mission logic, combat mechanics, narrative progression, interface feedback, and runtime reliability. Progress therefore requires both the construction of new capabilities and the continued operation of behavior introduced in earlier loops.

Development began in an empty workspace containing the PRD. The PRD specified the intended gameplay and player-observable acceptance criteria, while leaving the engineering decomposition, implementation order, and validation plan open. HoH was responsible for translating this product contract into an executable Godot project and for selecting, implementing, and evaluating the increments used to construct it.

We ran HoH with Codex CLI and GPT-5.6-Sol at high reasoning effort. At the analysis cutoff, the system had completed 70 development loops. Human involvement was limited to restoring network or API availability and did not extend to planning, implementation, debugging, testing, or acceptance.

##### Domain-Specific Skills and Tools.

Interactive game development requires more than source-code editing: the agents must manipulate engine state, produce compatible media assets, maintain a coherent interface, and test behavior through the running game. We therefore equipped HoH with domain-specific tools and reusable skills. Godot 4.7⁴⁴ 4 Godot Engine 4.7: [https://godotengine.org/releases/4.7/](https://godotengine.org/releases/4.7/) served as the development and runtime environment, while Godot MCP provided engine-level development, execution, and debugging capabilities. An asset-generation skill specified the target visual style, dimensions, and file formats for image, 3D, and video assets retrieved or generated by the corresponding tools. A UI/UX presentation skill supplied guidance on visual appearance and style consistency. A testing skill recorded scenario-specific testing considerations and guided debugging and validation through Godot MCP. All external assets incorporated during development were obtained under licenses permitting reuse, including CC0 and CC BY, with their source and required attribution preserved.

##### Verification Scope.

Benchmark configurations evaluate through bounded task-provided checks, including screenshots and smoke tests. For this case, the Tester additionally examined live keyboard input and the resulting game responses, audio behavior, and the integration of 3D assets.

##### Project State and Traceability.

We used GitHub for version control and issue tracking, retaining the commit and issue histories of the evolving project. At each loop, the working state was materialized in a development document, the versioned software workspace, and testing records comprising an issue table and evidence-packet files. These records allowed the three roles to modify, execute, and inspect the same project while retaining the artifact and observed test outcomes across loops. The GitHub repository linked on the title page provides the released project materials and selected development records for inspection of the process.

### 5.2 Development Dynamics Across Loops

Figure [1](#S0.F1 "Figure 1 ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") summarizes how Fusepoint evolved through 70 HoH loops. To characterize the development dynamics underlying this trajectory, we tracked newly recorded issues, QA-verified closures, reopened issues, and the unresolved issue count using the GitHub issue and commit histories together with the evidence packets produced during testing. These records reflect whether capability growth was accompanied by accumulating gaps and whether later loops returned to failures exposed during earlier development.

The observed trajectory through 70 loops contains three broad phases, distinguished by the relative prevalence of capability addition, issue discovery, and issue resolution. During initial construction (Loops 1–27), HoH established the executable project and its core interaction paths. Adding these initial capabilities also exposed missing requirements and defects, so the active issue backlog increased as the artifact became more testable.

Capability expansion (Loops 28–49) then combined new functionality with continued diagnosis and repair. Later loops operated on an increasingly integrated artifact, where a local change could affect mission state, combat, interface feedback, or runtime behavior established previously. As the planned capabilities approached completion, feature additions slowed and issue resolution became more prevalent, producing a stabilization phase in which the active backlog began to decline.

Issue resolution remained non-monotonic throughout this process. By Loop 70, 65 of the 81 recorded issues had been closed, leaving 16 unresolved. Seventeen issues were reopened after an earlier closure when a subsequent change caused previously verified behavior to fail again. A reopened record identifies both the failed behavior and its earlier verification history, making regression repair available as explicit project work to subsequent planning instead of requiring that history to be reconstructed from the latest artifact.

The trajectory consequently reflects the two forms of continuity required by iterative development. The versioned workspace allowed implementation work to accumulate, while its GitHub commit history made individual changes traceable. The issue history and evidence packets kept unfinished work, verified behavior, and regressions available for later planning. Development could therefore alternate among capability growth, repair, and preservation as the state of the project changed.

## 6 Conclusion and Future Work

We introduced Harness-of-Harness (HoH), which extends existing coding-agent harnesses to support software development from scratch without modifying their implementations. HoH organizes a fixed harness–model configuration into a continuous planning–coding–testing cycle, carrying evolving artifacts and execution evidence across iterations. On the benchmark tasks, HoH improves final artifact quality for all three evaluated configurations and continues to benefit from additional iterations. In the multi-day Fusepoint case, HoH developed a game project over 70 loops, with the versioned workspace, issue history, and evidence packets recording the development trajectory. Just as a coding harness structures model operation, HoH structures harness participation in long-horizon development. More broadly, HoH offers a practical path toward end-to-end software development through persistent, evidence-grounded orchestration of coding-agent harnesses. Future work will extend HoH to a broader range of real-world development scenarios, including different types of games and other software systems \[[42](#bib.bib44), [43](#bib.bib46), [44](#bib.bib45), [47](#bib.bib49), [37](#bib.bib50), [48](#bib.bib48)\], toward a general framework for autonomous software development.

## References

- \[1\] Anthropic (2025) Claude Code for Product Development. Note: Anthropic technical report External Links: [Link](https://www-cdn.anthropic.com/58284b19e702b49db9302d5b6f135ad8871e7658.pdf) Cited by: [§1](#S1.p1.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[2\] S. Barke, M. B. James, and N. Polikarpova (2023) Grounded copilot: how programmers interact with code-generating models. Proceedings of the ACM on Programming Languages 7 (OOPSLA1), pp. 85–111. External Links: [Document](https://dx.doi.org/10.1145/3586030), [Link](https://doi.org/10.1145/3586030) Cited by: [§1](#S1.p1.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[3\] M. Cemri, M. Z. Pan, S. Yang, L. A. Agrawal, B. Chopra, R. Tiwari, K. Keutzer, A. Parameswaran, D. Klein, K. Ramchandran, M. A. Zaharia, J. E. Gonzalez, and I. Stoica (2025) Why do multi-agent LLM systems fail?. In Advances in Neural Information Processing Systems, Vol. 38. External Links: [Link](https://proceedings.neurips.cc/paper_files/paper/2025/file/b1041e52d3be19f0a9bc491657488e4a-Paper-Datasets_and_Benchmarks_Track.pdf) Cited by: [§1](#S1.p2.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[4\] M. Chen, J. Tworek, H. Jun, Q. Yuan, H. P. de Oliveira Pinto, J. Kaplan, H. Edwards, Y. Burda, N. Joseph, G. Brockman, A. Ray, R. Puri, G. Krueger, M. Petrov, H. Khlaaf, G. Sastry, P. Mishkin, B. Chan, S. Gray, N. Ryder, M. Pavlov, A. Power, L. Kaiser, M. Bavarian, C. Winter, P. Tillet, F. P. Such, D. Cummings, M. Plappert, F. Chantzis, E. Barnes, A. Herbert-Voss, W. H. Guss, A. Nichol, A. Paino, N. Tezak, J. Tang, I. Babuschkin, S. Balaji, S. Jain, W. Saunders, C. Hesse, A. N. Carr, J. Leike, J. Achiam, V. Misra, E. Morikawa, A. Radford, M. Knight, M. Brundage, M. Murati, K. Mayer, P. Welinder, B. McGrew, D. Amodei, S. McCandlish, I. Sutskever, and W. Zaremba (2021) Evaluating large language models trained on code. CoRR abs/2107.03374. External Links: [Link](https://arxiv.org/abs/2107.03374) Cited by: [§1](#S1.p1.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[5\] M. Chen, J. Wang, Z. Liu, Y. Wang, H. Zheng, and Q. Wang (2026) From failed trajectories to reliable LLM agents: diagnosing and repairing harness flaws. External Links: 2606.06324, [Link](https://arxiv.org/abs/2606.06324) Cited by: [§1](#S1.p2.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[6\] E. Chu, R. Agarwal, A. Thangamuthu, B. Graham, J. Mattern, F. Jiang, P. Cento, S. Jain, M. Abbasi, M. H. Rezaei, G. Wang, A. Zhang, S. Guo, K. Nguyen, D. Liu, A. Bidgoli, A. Dalmia, A. Dankar, A. Vaddela, C. Chen, K. Kumar, K. Vaish, N. Pour, R. Kondra, S. Badiyani, S. Giri, S. Das, S. Gaikwad, S. Shah, V. Dilawari, and V. Agarwal (2026) FrontierSWE. Proximal Blog. Note: https://frontierswe.com/blog Cited by: [§B.4](#A2.SS4.p1.1 "B.4 Benchmark Sampling and Evaluated Tasks ‣ Appendix B Experimental Protocol ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§1](#S1.p5.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§4.1](#S4.SS1.SSS0.Px1.p1.1 "Benchmarks. ‣ 4.1 Experimental Setup ‣ 4 Experiments: Benchmark Evaluation ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[7\] L. Fu, X. Ding, Y. Zhu, S. Zhang, L. Qiu, W. Liu, W. Zhang, X. Cao, X. Cai, J. Ding, et al. (2026) CATArena: evaluation of llm agents through iterative tournament competitions. Proceedings of the 43rd International Conference on Machine Learning(ICML2026). Cited by: [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[8\] S. Hong, M. Zhuge, J. Chen, X. Zheng, Y. Cheng, J. Wang, C. Zhang, Z. Wang, S. Yau, Z. Lin, L. Zhou, C. Ran, L. Xiao, C. Wu, and J. Schmidhuber (2024) MetaGPT: meta programming for a multi-agent collaborative framework. In International Conference on Learning Representations, pp. 23247–23275. External Links: [Link](https://proceedings.iclr.cc/paper_files/paper/2024/file/6507b115562bb0a305f1958ccc87355a-Paper-Conference.pdf) Cited by: [§1](#S1.p2.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[9\] Y. Hu, Y. Cai, Y. Du, X. Zhu, X. Liu, Z. Yu, Y. Hou, S. Tang, and S. Chen (2025) Self-evolving multi-agent collaboration networks for software development. In International Conference on Learning Representations, pp. 23007–23039. External Links: [Link](https://proceedings.iclr.cc/paper_files/paper/2025/file/39af4f2f9399122a14ccf95e2d2e7122-Paper-Conference.pdf) Cited by: [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[10\] D. Huang, J. M. Zhang, M. Luck, Q. Bu, Y. Qing, and H. Cui (2023) AgentCoder: multi-agent-based code generation with iterative testing and optimisation. External Links: 2312.13010, [Document](https://dx.doi.org/10.48550/arXiv.2312.13010), [Link](https://arxiv.org/abs/2312.13010) Cited by: [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[11\] J. Huang, J. Hsia, J. Sun, F. Shi, W. Huang, and I. H. White (2026) Proof-or-stop: don’t trust the agent, trust the evidence—loop engineering for verifiable evidence-gated lifecycle control. External Links: 2607.14890, [Document](https://dx.doi.org/10.48550/arXiv.2607.14890), [Link](https://arxiv.org/abs/2607.14890) Cited by: [§1](#S1.p2.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[12\] C. E. Jimenez, J. Yang, A. Wettig, S. Yao, K. Pei, O. Press, and K. Narasimhan (2024) SWE-Bench: can language models resolve real-world GitHub issues?. In International Conference on Learning Representations, pp. 54107–54157. External Links: [Link](https://proceedings.iclr.cc/paper_files/paper/2024/file/edac78c3e300629acfe6cbe9ca88fb84-Paper-Conference.pdf) Cited by: [§1](#S1.p1.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[13\] C. Larman and V. R. Basili (2003) Iterative and incremental developments. a brief history. Computer 36 (6), pp. 47–56. Cited by: [§1](#S1.p3.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[14\] T. Le, M. V. T. Thai, D. N. Manh, H. P. Nhat, and N. D. Q. Bui (2025) SWE-EVO: Benchmarking Coding Agents in Long-Horizon Software Evolution Scenarios. External Links: 2512.18470, [Document](https://dx.doi.org/10.48550/arXiv.2512.18470), [Link](https://arxiv.org/abs/2512.18470) Cited by: [§1](#S1.p2.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[15\] Y. Lee, R. Nair, Q. Zhang, K. Lee, O. Khattab, and C. Finn (2026) Meta-Harness: end-to-end optimization of model harnesses. External Links: 2603.28052, [Document](https://dx.doi.org/10.48550/arXiv.2603.28052), [Link](https://arxiv.org/abs/2603.28052) Cited by: [§2](#S2.SS0.SSS0.Px1.p1.1 "Agent Harnesses. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[16\] J. Li, X. Xiao, Y. Zhang, C. Liu, L. Zhao, X. Liao, Y. Ji, J. Wang, Y. Ge, W. Xu, X. Fang, X. Xu, T. Zhao, Y. Kim, J. Hamm, T. Wang, and C. Reddy (2026) Agent harness engineering: a survey. External Links: [Link](https://openreview.net/pdf?id=eONq7FdiHa) Cited by: [§2](#S2.SS0.SSS0.Px1.p1.1 "Agent Harnesses. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[17\] J. Liu, X. Zhao, X. Shang, and Z. Shen (2026) Dive into Claude Code: the design space of today’s and future AI agent systems. External Links: 2604.14228, [Link](https://arxiv.org/abs/2604.14228) Cited by: [§2](#S2.SS0.SSS0.Px1.p1.1 "Agent Harnesses. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[18\] J. Liu, C. Xu, C. Wang, T. Bai, W. Chen, K. Wong, Y. Lou, and X. Peng (2026) Towards iterative end-to-end software development: a feature-driven multi-agent framework. Note: Accepted at the 35th ACM SIGSOFT International Symposium on Software Testing and Analysis (ISSTA 2026) External Links: 2511.02399, [Link](https://arxiv.org/abs/2511.02399) Cited by: [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[19\] P. Liu, W. Yuan, J. Fu, Z. Jiang, H. Hayashi, and G. Neubig (2023) Pre-train, prompt, and predict: a systematic survey of prompting methods in natural language processing. ACM Computing Surveys 55 (9), pp. 1–35. External Links: [Document](https://dx.doi.org/10.1145/3560815), [Link](https://doi.org/10.1145/3560815) Cited by: [§2](#S2.SS0.SSS0.Px1.p1.1 "Agent Harnesses. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[20\] X. Lou, M. Lázaro-Gredilla, A. Dedieu, C. Wendelken, W. Lehrach, and K. P. Murphy (2026) AutoHarness: improving LLM agents by automatically synthesizing a code harness. External Links: 2603.03329, [Document](https://dx.doi.org/10.48550/arXiv.2603.03329), [Link](https://arxiv.org/abs/2603.03329) Cited by: [§2](#S2.SS0.SSS0.Px1.p1.1 "Agent Harnesses. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[21\] P. Lu, S. Zhang, Y. Hou, L. Ye, C. Huang, Z. Chen, J. Zeng, H. Jiang, P. Liu, Y. Wang, and M. Yang (2026) ProjDevBench: Benchmarking AI Coding Agents on End-to-End Project Development. External Links: 2602.01655, [Document](https://dx.doi.org/10.48550/arXiv.2602.01655), [Link](https://arxiv.org/abs/2602.01655) Cited by: [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[22\] S. Lu, D. Guo, S. Ren, J. Huang, A. Svyatkovskiy, A. Blanco, C. Clement, D. Drain, D. Jiang, D. Tang, G. Li, L. Zhou, L. Shou, L. Zhou, M. Tufano, M. Gong, M. Zhou, N. Duan, N. Sundaresan, S. K. Deng, S. Fu, and S. Liu (2021) CodeXGLUE: a machine learning benchmark dataset for code understanding and generation. In Proceedings of the Neural Information Processing Systems Track on Datasets and Benchmarks, External Links: [Link](https://datasets-benchmarks-proceedings.neurips.cc/paper/2021/hash/c16a5320fa475530d9583c34fd356ef5-Abstract-round1.html) Cited by: [§1](#S1.p1.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[23\] T. Luo, R. Wang, J. Bi, C. Xu, Z. Tang, J. Chen, J. Liang, K. Ji, S. Guo, Y. Du, F. Bu, W. Du, X. Zhang, K. Li, S. Wang, L. Zhang, Y. Liu, X. Lai, C. Li, Y. Guo, Z. Zhang, X. Wang, T. Bai, Z. Li, and B. Wang (2026) GameCraft-Bench: Can Agents Build Playable Games End-to-End in a Real Game Engine?. External Links: 2606.17861, [Document](https://dx.doi.org/10.48550/arXiv.2606.17861), [Link](https://arxiv.org/abs/2606.17861) Cited by: [§B.4](#A2.SS4.p1.1 "B.4 Benchmark Sampling and Evaluated Tasks ‣ Appendix B Experimental Protocol ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§1](#S1.p5.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§4.1](#S4.SS1.SSS0.Px1.p1.1 "Benchmarks. ‣ 4.1 Experimental Setup ‣ 4 Experiments: Benchmark Evaluation ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[24\] A. Madaan, N. Tandon, P. Gupta, S. Hallinan, L. Gao, S. Wiegreffe, U. Alon, N. Dziri, S. Prabhumoye, Y. Yang, S. Gupta, B. P. Majumder, K. Hermann, S. Welleck, A. Yazdanbakhsh, and P. Clark (2023) Self-Refine: iterative refinement with self-feedback. In Advances in Neural Information Processing Systems, Vol. 36, pp. 46534–46594. External Links: [Link](https://proceedings.neurips.cc/paper_files/paper/2023/file/91edff07232fb1b55a505a9e9f6c0ff3-Paper-Conference.pdf) Cited by: [§1](#S1.p2.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[25\] M. A. Merrill, A. G. Shaw, N. Carlini, B. Li, H. Raj, I. Bercovich, L. Shi, J. Y. Shin, T. Walshe, E. K. Buchanan, et al. (2026) Terminal-bench: benchmarking agents on hard, realistic tasks in command line interfaces. arXiv preprint arXiv:2601.11868. Cited by: [§1](#S1.p1.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[26\] N. Mündler, M. N. Müller, J. He, and M. Vechev (2024) SWT-Bench: testing and validating real-world bug-fixes with code agents. In Advances in Neural Information Processing Systems, A. Globerson, L. Mackey, D. Belgrave, A. Fan, U. Paquet, J. Tomczak, and C. Zhang (Eds.), Vol. 37, pp. 81857–81887. External Links: [Document](https://dx.doi.org/10.52202/079017-2601), [Link](https://proceedings.neurips.cc/paper_files/paper/2024/file/94f093b41fc2666376fb1f667fe282f3-Paper-Conference.pdf) Cited by: [§1](#S1.p2.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[27\] M. H. Nguyen, T. Phan Chau, P. X. Nguyen, and N. D. Q. Bui (2025) AgileCoder: dynamic collaborative agents for software development based on agile methodology. In 2025 IEEE/ACM Second International Conference on AI Foundation Models and Software Engineering (FORGE), pp. 156–167. External Links: [Document](https://dx.doi.org/10.1109/FORGE66646.2025.00026), [Link](https://doi.org/10.1109/FORGE66646.2025.00026) Cited by: [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[28\] G. Orlanski, D. Roy, A. Yun, C. Shin, A. Gu, A. Ge, D. Adila, N. Roberts, F. Sala, and A. Albarghouthi (2026) SlopCodeBench: benchmarking how coding agents degrade over long-horizon iterative tasks. External Links: 2603.24755, [Document](https://dx.doi.org/10.48550/arXiv.2603.24755), [Link](https://arxiv.org/abs/2603.24755) Cited by: [§1](#S1.p2.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[29\] K. Oueslati, M. Lamothe, and F. Khomh (2026) RefAgent: A Multi-Agent LLM-Based Framework for Automatic Software Refactoring. In Proceedings of the 48th IEEE/ACM International Conference on Software Engineering, External Links: 2511.03153, [Link](https://arxiv.org/abs/2511.03153) Cited by: [§1](#S1.p1.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[30\] C. Packer, S. Wooders, K. Lin, V. Fang, S. G. Patil, I. Stoica, and J. E. Gonzalez (2024) MemGPT: towards LLMs as operating systems. External Links: 2310.08560, [Link](https://arxiv.org/abs/2310.08560) Cited by: [§2](#S2.SS0.SSS0.Px1.p1.1 "Agent Harnesses. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[31\] S. A. C. Perrig, N. Scharowski, F. Brühlmann, N. von Felten, K. Opwis, and L. F. Aeschbach (2024) Independent validation of the player experience inventory: findings from a large set of video game players. In Proceedings of the 2024 CHI Conference on Human Factors in Computing Systems, CHI ’24, New York, NY, USA. External Links: [Document](https://dx.doi.org/10.1145/3613904.3642270), [Link](https://doi.org/10.1145/3613904.3642270) Cited by: [§B.8](#A2.SS8.p2.1 "B.8 Player-Experience Evaluation and PXI Aggregation ‣ Appendix B Experimental Protocol ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[32\] C. Qian, W. Liu, H. Liu, N. Chen, Y. Dang, J. Li, C. Yang, W. Chen, Y. Su, X. Cong, J. Xu, D. Li, Z. Liu, and M. Sun (2024) ChatDev: communicative agents for software development. In Proceedings of the 62nd Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers), pp. 15174–15186. External Links: [Document](https://dx.doi.org/10.18653/v1/2024.acl-long.810), [Link](https://aclanthology.org/2024.acl-long.810/) Cited by: [§1](#S1.p2.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[33\] N. Shinn, F. Cassano, A. Gopinath, K. Narasimhan, and S. Yao (2023) Reflexion: language agents with verbal reinforcement learning. In Advances in Neural Information Processing Systems, Vol. 36, pp. 8634–8652. External Links: [Link](https://proceedings.neurips.cc/paper_files/paper/2023/file/1b44b878bb782e6954cd888628510e90-Paper-Conference.pdf) Cited by: [§1](#S1.p2.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[34\] V. Vanden Abeele, K. Spiel, L. E. Nacke, D. Johnson, and K. Gerling (2020) Development and validation of the player experience inventory: a scale to measure player experiences at the level of functional and psychosocial consequences. International Journal of Human-Computer Studies 135, pp. 102370. External Links: [Document](https://dx.doi.org/10.1016/j.ijhcs.2019.102370), [Link](https://doi.org/10.1016/j.ijhcs.2019.102370) Cited by: [§B.8](#A2.SS8.p1.1 "B.8 Player-Experience Evaluation and PXI Aggregation ‣ Appendix B Experimental Protocol ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[35\] X. Wang, B. Li, Y. Song, F. F. Xu, X. Tang, M. Zhuge, J. Pan, Y. Song, B. Li, J. Singh, H. Tran, F. Li, R. Ma, M. Zheng, B. Qian, D. Shao, N. Muennighoff, Y. Zhang, B. Hui, J. Lin, R. Brennan, H. Peng, H. Ji, and G. Neubig (2025) OpenHands: an open platform for AI software developers as generalist agents. In International Conference on Learning Representations, pp. 65882–65919. External Links: [Link](https://proceedings.iclr.cc/paper_files/paper/2025/file/a4b6ad6b48850c0c331d1259fc66a69c-Paper-Conference.pdf) Cited by: [§1](#S1.p1.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§1](#S1.p2.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§1](#S1.p3.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[36\] Y. Wang, H. Le, A. Gotmare, N. D. Q. Bui, J. Li, and S. C. H. Hoi (2023) CodeT5+: open code large language models for code understanding and generation. In Proceedings of the 2023 Conference on Empirical Methods in Natural Language Processing, pp. 1069–1088. External Links: [Document](https://dx.doi.org/10.18653/v1/2023.emnlp-main.68), [Link](https://aclanthology.org/2023.emnlp-main.68/) Cited by: [§1](#S1.p1.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[37\] X. Wang\*, S. Zhang\*, W. Zhang, W. Dong, J. Chen, Y. Wen, and W. Zhang (2024) ZSC-eval: an evaluation toolkit and benchmark for multi-agent zero-shot coordination. The 38th Conference on Neural Information Processing Systems (NeurIPS 2024) Track on Datasets and Benchmarks. External Links: 2310.05208 Cited by: [§6](#S6.p1.1 "6 Conclusion and Future Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[38\] C. S. Xia, Y. Deng, S. Dunn, and L. Zhang (2025) Demystifying LLM-based software engineering agents. Proceedings of the ACM on Software Engineering 2 (FSE), pp. 801–824. External Links: [Document](https://dx.doi.org/10.1145/3715754), [Link](https://doi.org/10.1145/3715754) Cited by: [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[39\] J. Yang, C. E. Jimenez, A. Wettig, K. Lieret, S. Yao, K. Narasimhan, and O. Press (2024) SWE-Agent: agent-computer interfaces enable automated software engineering. In Advances in Neural Information Processing Systems, Vol. 37, pp. 50528–50652. External Links: [Document](https://dx.doi.org/10.52202/079017-1601), [Link](https://proceedings.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf) Cited by: [§1](#S1.p1.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§1](#S1.p3.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[40\] J. Yang, K. Lieret, J. Ma, P. Thakkar, D. Pedchenko, S. Sootla, E. McMilin, P. Yin, R. Hou, G. Synnaeve, D. Yang, and O. Press (2026) ProgramBench: Can Language Models Rebuild Programs From Scratch?. External Links: 2605.03546, [Link](https://arxiv.org/abs/2605.03546) Cited by: [§1](#S1.p5.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§4.1](#S4.SS1.SSS0.Px1.p1.1 "Benchmarks. ‣ 4.1 Experimental Setup ‣ 4 Experiments: Benchmark Evaluation ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[41\] S. Yao, J. Zhao, D. Yu, N. Du, I. Shafran, K. R. Narasimhan, and Y. Cao (2023) ReAct: synergizing reasoning and acting in language models. In International Conference on Learning Representations, External Links: [Link](https://openreview.net/forum?id=WE_vluYUL-X) Cited by: [§2](#S2.SS0.SSS0.Px1.p1.1 "Agent Harnesses. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[42\] C. Zhang, Q. He, Z. Yuan, E. S. Liu, H. Wang, J. Zhao, and Y. Wang (2024) Advancing drl agents in commercial fighting games: training, integration, and agent-human alignment. arXiv preprint arXiv:2406.01103. Cited by: [§6](#S6.p1.1 "6 Conclusion and Future Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[43\] C. Zhang, H. Hu, Y. Zhou, Q. Cao, R. Liu, W. Wei, and E. S. Liu (2024) Training interactive agent in large fps game map with rule-enhanced reinforcement learning. In 2024 IEEE Conference on Games (CoG), pp. 1–8. Cited by: [§6](#S6.p1.1 "6 Conclusion and Future Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[44\] C. Zhang, H. Hu, Y. Zhou, X. Wang, and E. S. Liu (2025) HIFAS: a hybrid interactive fps agent system for large game maps. IEEE Transactions on Games (), pp. 1–13. External Links: [Document](https://dx.doi.org/10.1109/TG.2025.3567869) Cited by: [§6](#S6.p1.1 "6 Conclusion and Future Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[45\] H. Zhang, S. Zhang, K. Li, C. Zhang, Y. Chen, Y. Zhang, L. Bai, and S. Hu (2026) Self-Harness: harnesses that improve themselves. External Links: 2606.09498, [Document](https://dx.doi.org/10.48550/arXiv.2606.09498), [Link](https://arxiv.org/abs/2606.09498) Cited by: [§1](#S1.p3.1 "1 Introduction ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), [§2](#S2.SS0.SSS0.Px1.p1.1 "Agent Harnesses. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[46\] Q. Zhang, C. Hu, S. Upasani, B. Ma, F. Hong, V. Kamanuru, J. Rainton, C. Wu, M. Ji, H. Li, U. Thakker, J. Zou, and K. Olukotun (2026) Agentic context engineering: evolving contexts for self-improving language models. In International Conference on Learning Representations, External Links: [Link](https://openreview.net/forum?id=eC4ygDs02R) Cited by: [§2](#S2.SS0.SSS0.Px1.p1.1 "Agent Harnesses. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[47\] S. Zhang\*, X. Wang\*, W. Zhang, Y. Chen, L. Gao, D. Wang, W. Zhang, X. Wang, and Y. Wen (2024) Mutual theory of mind in human-ai collaboration: an empirical study with llm-driven ai agents in a real-time shared workspace task. Preprint Under Review. External Links: 2409.08811 Cited by: [§6](#S6.p1.1 "6 Conclusion and Future Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[48\] S. Zhang\*, X. Wang\*, W. Zhang, C. Li, J. Song, T. Li, L. Qiu, X. Cao, X. Cai, W. Yao, W. Zhang, X. Wang, and Y. Wen (2025) Leveraging dual process theory in language agent framework for real-time simultaneous human-ai collaboration. ACL 2025. Cited by: [§6](#S6.p1.1 "6 Conclusion and Future Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[49\] W. Zhao, N. Jiang, C. Lee, J. Chiu, C. Cardie, M. Gallé, and A. Rush (2025) Commit0: library generation from scratch. In International Conference on Learning Representations, pp. 12061–12076. External Links: [Link](https://proceedings.iclr.cc/paper_files/paper/2025/file/1fcefa894924bb1688041b7a26fb8aea-Paper-Conference.pdf) Cited by: [§2](#S2.SS0.SSS0.Px2.p1.1 "Agentic Systems for Software Development. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").
- \[50\] M. Zhuge, W. Wang, L. Kirsch, F. Faccio, D. Khizbullin, and J. Schmidhuber (2024) GPTSwarm: language agents as optimizable graphs. In Proceedings of the 41st International Conference on Machine Learning, Proceedings of Machine Learning Research, Vol. 235, pp. 62743–62767. External Links: [Link](https://proceedings.mlr.press/v235/zhuge24a.html) Cited by: [§2](#S2.SS0.SSS0.Px1.p1.1 "Agent Harnesses. ‣ 2 Related Work ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement").

Supplementary Material

## Appendix A Method and Implementation Details

### A.1 HoH Execution Protocol

This section expands the method specification in the main paper into its executable interfaces. Within one experimental condition, the *Project Planner*, *Developer*, and *Quality Assurance (QA) Tester* are three independent invocations of the same harness–model configuration $H$. Their model and native harness capabilities remain fixed, while role-specific instructions determine what each invocation may read, modify, and return. The three roles coordinate around the same evolving software artifact. The Developer writes to the active project workspace, whereas the Planner consumes materialized documents and the QA Tester inspects an isolated copy of the current artifact. The latter two return structured records rather than modifying the active artifact through an interactive conversation.

Table [4](#A1.T4 "Table 4 ‣ A.1 HoH Execution Protocol ‣ Appendix A Method and Implementation Details ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") details the implementation-level inputs and outputs corresponding to the notation in the main paper. The Planner receives the public specification $\mathcal{S}$ and preceding evidence $\mathcal{E}_{t - 1}$ and produces the current development document $D_{t}$. The Developer receives $\mathcal{S}$ and $D_{t}$ in the workspace containing $A_{t - 1}$ and writes the updated artifact $A_{t}$. The QA Tester receives $\mathcal{S}$, $D_{t}$, and $A_{t}$, executes and inspects the artifact, and produces $\mathcal{E}_{t}$.

Accordingly, one HoH iteration is implemented by three harness invocations:

|     |                   |                                                                                          |     |     |
|-----|-------------------|------------------------------------------------------------------------------------------|-----|-----|
|     | $D_{t}$           | ${\phantom{} = {{Plan}_{H}\hspace{0pt}\left( \mathcal{S},\mathcal{E}_{t - 1} \right)}},$ |     | (3) |
|     | $A_{t}$           | ${\phantom{} = {{Dev}_{H}\hspace{0pt}\left( A_{t - 1},\mathcal{S},D_{t} \right)}},$      |     |     |
|     | $\mathcal{E}_{t}$ | ${\phantom{} = {{Test}_{H}\hspace{0pt}\left( A_{t},\mathcal{S},D_{t} \right)}}.$         |     |     |

The three invocations share the fixed configuration $H$, but each receives the role-specific inputs shown in Table [4](#A1.T4 "Table 4 ‣ A.1 HoH Execution Protocol ‣ Appendix A Method and Implementation Details ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"). The artifact and evidence bundle cross the iteration boundary; within iteration $t$, $D_{t}$ provides the common specification for coding and testing.

|  Role             |  Inputs                                                            |  Invocation contract                                                                                                                                                                                  |  Materialized output                             |
|-------------------|--------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------|
|  Project Planner  |  $\mathcal{S}$ and $\mathcal{E}_{t - 1}$                           |  Select bounded priorities from public requirements and preceding evidence; identify verified functionality to preserve; specify observable acceptance requirements; do not modify production code    |  Development document $D_{t}$                    |
|  Developer        |  $\mathcal{S}$, $D_{t}$, and the workspace containing $A_{t - 1}$  |  Address prioritized targets with native coding tools; preserve verified functionality; keep the project buildable and runnable; write changes into the existing workspace                            |  Updated artifact $A_{t}$ and execution records  |
|  QA Tester        |  $\mathcal{S}$, $D_{t}$, $A_{t}$, and public execution records     |  Derive checkable claims; execute and inspect the artifact; associate findings with observable records; distinguish supported functionality from unresolved or insufficiently evidenced requirements  |  Evidence bundle $\mathcal{E}_{t}$               |

Table 4: Inputs, invocation contracts, and materialized outputs of the three HoH roles. All roles use the harness–model configuration associated with the corresponding experimental condition.

### A.2 Role-Specific Prompt Construction

Each role prompt is rendered from reusable Markdown modules and runtime values. The fixed modules specify role boundaries, public-information policy, and the output contract; runtime slots insert the public task, current iteration state, materialized documents, and execution records. The public task specification is inserted without modification. At $t = 1$, the Planner’s evidence slot is empty; for $t > 1$, it contains the structured evidence bundle from the preceding artifact. The templates below are schematic, interface-preserving renderings of the runtime prompts: they retain the role contracts and data dependencies used by the method while omitting repeated benchmark-specific examples and checklists. In the templates, {{runtime_slot}} denotes substituted content, /workspace/path denotes a materialized file or directory, and \[conditional module\] denotes a block included only when its runtime condition is satisfied.

![](data:image/svg+xml;base64,PHN2ZyBjbGFzcz0ibHR4X3BpY3R1cmUiIGhlaWdodD0iODMxLjA4IiBpZD0iQTEuU1MyLnAyLnBpYzEiIG92ZXJmbG93PSJ2aXNpYmxlIiB2ZXJzaW9uPSIxLjEiIHZpZXdib3g9IjAgMCA2NTMuMTUgODMxLjA4IiB3aWR0aD0iNjUzLjE1Ij48ZyBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHN0cm9rZS13aWR0aD0iMC40cHQiIHN0eWxlPSItLWx0eC1zdHJva2UtY29sb3I6IzAwMDAwMDstLWx0eC1maWxsLWNvbG9yOiMwMDAwMDA7IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLDgzMS4wOCkgbWF0cml4KDEgMCAwIC0xIDAgMCkiPjxnIGZpbGw9IiMwMDAwMDAiIGZpbGwtb3BhY2l0eT0iMS4wIiBzdHlsZT0iLS1sdHgtZmlsbC1jb2xvcjojMDAwMDAwOyI+PHBhdGggZD0iTSAwIDMuNzQgTCAwIDgyNy4zNCBDIDAgODI5LjQxIDEuNjcgODMxLjA4IDMuNzQgODMxLjA4IEwgNjQ5LjQxIDgzMS4wOCBDIDY1MS40OCA4MzEuMDggNjUzLjE1IDgyOS40MSA2NTMuMTUgODI3LjM0IEwgNjUzLjE1IDMuNzQgQyA2NTMuMTUgMS42NyA2NTEuNDggMCA2NDkuNDEgMCBMIDMuNzQgMCBDIDEuNjcgMCAwIDEuNjcgMCAzLjc0IFoiIHN0eWxlPSJzdHJva2U6bm9uZSIgLz48L2c+PGcgZmlsbD0iI0YyRjJGMiIgZmlsbC1vcGFjaXR5PSIxLjAiIHN0eWxlPSItLWx0eC1maWxsLWNvbG9yOiNGMkYyRjI7Ij48cGF0aCBkPSJNIDAuOTcgMy43NCBMIDAuOTcgODA4Ljk3IEwgNjUyLjE4IDgwOC45NyBMIDY1Mi4xOCAzLjc0IEMgNjUyLjE4IDIuMjEgNjUwLjk0IDAuOTcgNjQ5LjQxIDAuOTcgTCAzLjc0IDAuOTcgQyAyLjIxIDAuOTcgMC45NyAyLjIxIDAuOTcgMy43NCBaIiBzdHlsZT0ic3Ryb2tlOm5vbmUiIC8+PC9nPjxnIGZpbGwtb3BhY2l0eT0iMS4wIiB0cmFuc2Zvcm09Im1hdHJpeCgxLjAgMC4wIDAuMCAxLjAgMTQuNTkgODE2LjU2KSI+PGZvcmVpZ25vYmplY3QgaGVpZ2h0PSIxMi4zIiBvdmVyZmxvdz0idmlzaWJsZSIgc3R5bGU9Ii0tbHR4LWZvLXdpZHRoOjQwLjk5ZW07LS1sdHgtZm8taGVpZ2h0OjAuNjllbTstLWx0eC1mby1kZXB0aDowLjE5ZW07Zm9udC1zaXplOjEwcHQ7IiB0cmFuc2Zvcm09Im1hdHJpeCgxIDAgMCAtMSAwIDkuNjEpIiB3aWR0aD0iNTY3LjE5Ij48c3BhbiBjbGFzcz0ibHR4X2ZvcmVpZ25vYmplY3RfY29udGFpbmVyIj48c3BhbiBjbGFzcz0ibHR4X2ZvcmVpZ25vYmplY3RfY29udGVudCI+CjxzcGFuIGNsYXNzPSJsdHhfaW5saW5lLWJsb2NrIGx0eF9taW5pcGFnZSBsdHhfYWxpZ25fYm90dG9tIiBpZD0iQTEuU1MyLnAyLnBpYzEuMSIgc3R5bGU9IndpZHRoOjQwLjk5ZW07Ij4KPHNwYW4gY2xhc3M9Imx0eF9wIiBpZD0iQTEuU1MyLnAyLnBpYzEuMS4xIj48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfc2Fuc3NlcmlmIGx0eF9mb250X2JvbGQiIGlkPSJBMS5TUzIucDIucGljMS4xLjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiNGRkZGRkY7Ij5Qcm9qZWN0IFBsYW5uZXIgUHJvbXB0PC9zcGFuPjwvc3Bhbj4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+PC9mb3JlaWdub2JqZWN0PjwvZz48ZyBmaWxsLW9wYWNpdHk9IjEuMCIgdHJhbnNmb3JtPSJtYXRyaXgoMS4wIDAuMCAwLjAgMS4wIDE0LjU5IDE1Ljk4KSI+PGZvcmVpZ25vYmplY3QgaGVpZ2h0PSI3ODMuNTMiIG92ZXJmbG93PSJ2aXNpYmxlIiBzdHlsZT0iLS1sdHgtZm8td2lkdGg6NDguNzVlbTstLWx0eC1mby1oZWlnaHQ6NTYuNDNlbTstLWx0eC1mby1kZXB0aDowLjJlbTtmb250LXNpemU6MTBwdDsiIHRyYW5zZm9ybT0ibWF0cml4KDEgMCAwIC0xIDAgNzgwLjc2KSIgd2lkdGg9IjY3NC41NiI+PHNwYW4gY2xhc3M9Imx0eF9mb3JlaWdub2JqZWN0X2NvbnRhaW5lciI+PHNwYW4gY2xhc3M9Imx0eF9mb3JlaWdub2JqZWN0X2NvbnRlbnQiPgo8c3BhbiBjbGFzcz0ibHR4X2lubGluZS1ibG9jayBsdHhfbWluaXBhZ2UgbHR4X2FsaWduX2JvdHRvbSIgaWQ9IkExLlNTMi5wMi5waWMxLjIiIHN0eWxlPSJ3aWR0aDo0OC43NWVtOyI+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X2JvbGQiIGlkPSJBMS5TUzIucDIucGljMS4yLjEuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7LS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPlRlbXBsYXRlIGFzc2VtYmx5LjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9tZWRpdW0iIGlkPSJBMS5TUzIucDIucGljMS4yLjEuMS4xIj7igIM8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMS4xLjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5bcm9sZSBpbnN0cnVjdGlvbl08L3NwYW4+CjxtYXRoIGFsdHRleHQ9IlxvcGx1cyIgY2xhc3M9Imx0eF9NYXRoIiBkaXNwbGF5PSJpbmxpbmUiIGlkPSJBMS5TUzIucDIucGljMS5tMSIgaW50ZW50PSI6bGl0ZXJhbCI+PHNlbWFudGljcz48bW8gbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPuKKlTwvbW8+PGFubm90YXRpb24gZW5jb2Rpbmc9ImFwcGxpY2F0aW9uL3gtdGV4Ij5cb3BsdXM8L2Fubm90YXRpb24+PC9zZW1hbnRpY3M+PC9tYXRoPgo8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMS4xLjEuMiIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5bcHVibGljIHNwZWNpZmljYXRpb25dPC9zcGFuPgo8bWF0aCBhbHR0ZXh0PSJcb3BsdXMiIGNsYXNzPSJsdHhfTWF0aCIgZGlzcGxheT0iaW5saW5lIiBpZD0iQTEuU1MyLnAyLnBpYzEubTIiIGludGVudD0iOmxpdGVyYWwiPjxzZW1hbnRpY3M+PG1vIG1hdGhjb2xvcj0iIzAwMDAwMCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij7iipU8L21vPjxhbm5vdGF0aW9uIGVuY29kaW5nPSJhcHBsaWNhdGlvbi94LXRleCI+XG9wbHVzPC9hbm5vdGF0aW9uPjwvc2VtYW50aWNzPjwvbWF0aD4KPHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDIucGljMS4yLjEuMS4xLjMiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+W3ByZWNlZGluZyBldmlkZW5jZV08L3NwYW4+CjxtYXRoIGFsdHRleHQ9IlxvcGx1cyIgY2xhc3M9Imx0eF9NYXRoIiBkaXNwbGF5PSJpbmxpbmUiIGlkPSJBMS5TUzIucDIucGljMS5tMyIgaW50ZW50PSI6bGl0ZXJhbCI+PHNlbWFudGljcz48bW8gbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPuKKlTwvbW8+PGFubm90YXRpb24gZW5jb2Rpbmc9ImFwcGxpY2F0aW9uL3gtdGV4Ij5cb3BsdXM8L2Fubm90YXRpb24+PC9zZW1hbnRpY3M+PC9tYXRoPgo8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMS4xLjEuNCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5bZG9jdW1lbnQgc2NhZmZvbGRdPC9zcGFuPgo8bWF0aCBhbHR0ZXh0PSJcb3BsdXMiIGNsYXNzPSJsdHhfTWF0aCIgZGlzcGxheT0iaW5saW5lIiBpZD0iQTEuU1MyLnAyLnBpYzEubTQiIGludGVudD0iOmxpdGVyYWwiPjxzZW1hbnRpY3M+PG1vIG1hdGhjb2xvcj0iIzAwMDAwMCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij7iipU8L21vPjxhbm5vdGF0aW9uIGVuY29kaW5nPSJhcHBsaWNhdGlvbi94LXRleCI+XG9wbHVzPC9hbm5vdGF0aW9uPjwvc2VtYW50aWNzPjwvbWF0aD4KPHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDIucGljMS4yLjEuMS4xLjUiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+W291dHB1dCBjb250cmFjdF08L3NwYW4+PC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMiI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X2JvbGQiIGlkPSJBMS5TUzIucDIucGljMS4yLjIuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7LS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPk1ldGhvZCBjb3JyZXNwb25kZW5jZS48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfbWVkaXVtIiBpZD0iQTEuU1MyLnAyLnBpYzEuMi4yLjEuMSI+4oCDPG1hdGggYWx0dGV4dD0iXGxlZnQoXG1hdGhjYWx7U30sXG1hdGhjYWx7RX1fe3QtMX1ccmlnaHQpXHhyaWdodGFycm93e1xtYXRocm17UGxhbn1fe0h9fURfe3R9IiBjbGFzcz0ibHR4X01hdGgiIGRpc3BsYXk9ImlubGluZSIgaWQ9IkExLlNTMi5wMi5waWMxLm01IiBpbnRlbnQ9IjpsaXRlcmFsIj48c2VtYW50aWNzPjxtcm93Pjxtcm93PjxtbyBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+KDwvbW8+PG1pIGNsYXNzPSJsdHhfZm9udF9tYXRoY2FsaWdyYXBoaWMiIG1hdGhjb2xvcj0iIzAwMDAwMCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij7wnZKuPC9taT48bW8gbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPiw8L21vPjxtc3ViPjxtaSBjbGFzcz0ibHR4X2ZvbnRfbWF0aGNhbGlncmFwaGljIiBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+4oSwPC9taT48bXJvdz48bWkgbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPnQ8L21pPjxtbyBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+4oiSPC9tbz48bW4gbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPjE8L21uPjwvbXJvdz48L21zdWI+PG1vIG1hdGhjb2xvcj0iIzAwMDAwMCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4pPC9tbz48L21yb3c+PG1vdmVyIGFjY2VudD0idHJ1ZSI+PG1vIG1hdGhjb2xvcj0iIzAwMDAwMCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij7ihpI8L21vPjxtc3ViPjxtaSBtYXRoY29sb3I9IiMwMDAwMDAiIG1hdGhzaXplPSIwLjcwMGVtIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPlBsYW48L21pPjxtaSBtYXRoY29sb3I9IiMwMDAwMDAiIG1hdGhzaXplPSIwLjcxMGVtIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPkg8L21pPjwvbXN1Yj48L21vdmVyPjxtc3ViPjxtaSBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+RDwvbWk+PG1pIG1hdGhjb2xvcj0iIzAwMDAwMCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij50PC9taT48L21zdWI+PC9tcm93Pjxhbm5vdGF0aW9uIGVuY29kaW5nPSJhcHBsaWNhdGlvbi94LXRleCI+XGxlZnQoXG1hdGhjYWx7U30sXG1hdGhjYWx7RX1fe3QtMX1ccmlnaHQpXHhyaWdodGFycm93e1xtYXRocm17UGxhbn1fe0h9fURfe3R9PC9hbm5vdGF0aW9uPjwvc2VtYW50aWNzPjwvbWF0aD48L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAyLnBpYzEuMi4zIj48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMy4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTsiPi9yb2xlL3Byb2plY3QtcGxhbm5lcjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9zZXJpZiIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMy4xLjEiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+Cjwvc3Bhbj48L3NwYW4+PC9zcGFuPgo8c3BhbiBjbGFzcz0ibHR4X3AgbHR4X2FsaWduX2xlZnQiIGlkPSJBMS5TUzIucDIucGljMS4yLjQiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuNC4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTstLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+WW91IGFyZSB0aGUgUHJvamVjdCBQbGFubmVyIGZvciBpdGVyYXRpb24gPHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDIucGljMS4yLjQuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPnt7bG9vcF9pbmRleH19PC9zcGFuPiBvZiBhbgppdGVyYXRpdmUgc29mdHdhcmUtZGV2ZWxvcG1lbnQgcnVuLiBUaGlzIGlzIGEgcGxhbm5pbmctb25seSBoYXJuZXNzCmludm9jYXRpb24uIERvIG5vdCBpbXBsZW1lbnQsIGVkaXQsIHRlc3QsIG9yIGluc3BlY3QgcHJvZHVjdGlvbiBjb2RlLiBSZXR1cm4Kb25seSBhIHByaW9yaXRpemF0aW9uIG92ZXJsYXkgZm9yIHRoZSBkZXRlcm1pbmlzdGljIGRldmVsb3BtZW50IGRvY3VtZW50Ljwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuNSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDIucGljMS4yLjUuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7Ij4vc291cmNlLW9mLXRydXRoPHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3NlcmlmIiBpZD0iQTEuU1MyLnAyLnBpYzEuMi41LjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuNiI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IiBpZD0iQTEuU1MyLnAyLnBpYzEuMi42LjEiIHN0eWxlPSJmb250LXNpemU6OTAlOy0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5UaGUgcHVibGljIDxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAyLnBpYzEuMi42LjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij57e3Rhc2tfc291cmNlX25hbWV9fTwvc3Bhbj4gc3BlY2lmaWNhdGlvbiBiZWxvdyBpcyB0aGUgY29tcGxldGUKcHJvZHVjdCBzb3VyY2Ugb2YgdHJ1dGguIERvIG5vdCB1c2UgYmVuY2htYXJrIHNjb3JlcywgaGlkZGVuIHRlc3RzLCBwcml2YXRlCnJ1YnJpY3MsIGV2YWx1YXRvciBmZWVkYmFjaywgb3Igb3RoZXIgbm9uLXB1YmxpYyBpbmZvcm1hdGlvbi48L3NwYW4+PC9zcGFuPgo8c3BhbiBjbGFzcz0ibHR4X3AgbHR4X2FsaWduX2xlZnQiIGlkPSJBMS5TUzIucDIucGljMS4yLjciPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAyLnBpYzEuMi43LjEiIHN0eWxlPSJmb250LXNpemU6OTAlOyI+e3twdWJsaWNfdGFza19pbnN0cnVjdGlvbn19PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3NlcmlmIiBpZD0iQTEuU1MyLnAyLnBpYzEuMi43LjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuOCI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDIucGljMS4yLjguMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7Ij4vcHJldmlvdXMtaXRlcmF0aW9uLWV2aWRlbmNlPHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3NlcmlmIiBpZD0iQTEuU1MyLnAyLnBpYzEuMi44LjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuOSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDIucGljMS4yLjkuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7Ij57e2V2aWRlbmNlX3BhY2tldH19PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3NlcmlmIiBpZD0iQTEuU1MyLnAyLnBpYzEuMi45LjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMTAiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMTAuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7LS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPkZvciBpdGVyYXRpb24gMSwgdGhlcmUgaXMgbm8gcHJldmlvdXMtaXRlcmF0aW9uIGV2aWRlbmNlLiBGb3IgbGF0ZXIKaXRlcmF0aW9ucywgaWRlbnRpZnkgdmVyaWZpZWQgZnVuY3Rpb25hbGl0eSB0byBwcmVzZXJ2ZSwgdmlzaWJsZSBidWdzIGFuZAp1bm1ldCByZXF1aXJlbWVudHMgdG8gcmVwYWlyLCBhbmQgZXZpZGVuY2UgdGhhdCByZW1haW5zIGluc3VmZmljaWVudC4gRG8gbm90CnJlcXVlc3Qgb3IgcmVjb25zdHJ1Y3QgdGhlIHByZXZpb3VzIGRldmVsb3BtZW50IGRvY3VtZW50Ljwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMTEiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAyLnBpYzEuMi4xMS4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTsiPi9wbGFubmluZy1wb2xpY3k8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfc2VyaWYiIGlkPSJBMS5TUzIucDIucGljMS4yLjExLjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMTIiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMTIuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7LS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPlByaW9yaXRpemUgYmxvY2tlcnMgYW5kIHJlZ3Jlc3Npb25zIGJlZm9yZSBwcm9kdWN0IGV4dGVuc2lvbnMuIFNlbGVjdCBhdCBtb3N0CnRocmVlIGFjaGlldmFibGUgcHJpb3JpdGllcyBhbHJlYWR5IHN1cHBvcnRlZCBieSB0aGUgZG9jdW1lbnQgc2NhZmZvbGQuCkNvbnZlcnQgZWFjaCBwcmlvcml0eSBpbnRvIGEgY29uY3JldGUgaW1wbGVtZW50YXRpb24gdGFyZ2V0IGFuZCBhbiBvYnNlcnZhYmxlCnZhbGlkYXRpb24gcmVxdWlyZW1lbnQ7IGF2b2lkIGJyb2FkIHJld3JpdGVzIG9yIHVucmVsYXRlZCBhcmNoaXRlY3R1cmUKY2hhbmdlcy48L3NwYW4+PC9zcGFuPgo8c3BhbiBjbGFzcz0ibHR4X3AgbHR4X2FsaWduX2xlZnQiIGlkPSJBMS5TUzIucDIucGljMS4yLjEzIj48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMTMuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7Ij4vZG9jdW1lbnQtc2NhZmZvbGQ8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfc2VyaWYiIGlkPSJBMS5TUzIucDIucGljMS4yLjEzLjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMTQiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAyLnBpYzEuMi4xNC4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTsiPnt7c2NhZmZvbGRfZG9jdW1lbnR9fTxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9zZXJpZiIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMTQuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAyLnBpYzEuMi4xNSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDIucGljMS4yLjE1LjEiIHN0eWxlPSJmb250LXNpemU6OTAlOyI+L291dHB1dC1jb250cmFjdDxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9zZXJpZiIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMTUuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAyLnBpYzEuMi4xNiI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IiBpZD0iQTEuU1MyLnAyLnBpYzEuMi4xNi4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTstLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+UmV0dXJuIG9ubHkgdGhlIGZvbGxvd2luZyBNYXJrZG93biBzdHJ1Y3R1cmU6PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAyLnBpYzEuMi4xNyI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDIucGljMS4yLjE3LjEiIHN0eWxlPSJmb250LXNpemU6OTAlOy0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4jIyBQcm9qZWN0IFBsYW5uZXIgUHJpb3JpdGllczwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMTgiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAyLnBpYzEuMi4xOC4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTstLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+IyMjIFByaW9yaXR5IE9yZGVyPC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAyLnBpYzEuMi4xOSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDIucGljMS4yLjE5LjEiIHN0eWxlPSJmb250LXNpemU6OTAlOy0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4xLiAqKlByaW9yaXR5IG5hbWUqKiAtLSBhY3Rpb24gYW5kIG9ic2VydmFibGUgb3V0Y29tZTwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMi5waWMxLjIuMjAiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAyLnBpYzEuMi4yMC4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTstLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+IyMjIFByZXNlcnZhdGlvbiBHYXRlPC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAyLnBpYzEuMi4yMSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDIucGljMS4yLjIxLjEiIHN0eWxlPSJmb250LXNpemU6OTAlOy0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4tIFdvcmtpbmcgZnVuY3Rpb25hbGl0eSBhbmQgZXZpZGVuY2UgdGhhdCBtdXN0IG5vdCByZWdyZXNzPC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAyLnBpYzEuMi4yMiI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDIucGljMS4yLjIyLjEiIHN0eWxlPSJmb250LXNpemU6OTAlOy0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4jIyMgQWNjZXB0YW5jZSBHYXRlPC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAyLnBpYzEuMi4yMyI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDIucGljMS4yLjIzLjEiIHN0eWxlPSJmb250LXNpemU6OTAlOy0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4tIFNtYWxsZXN0IGVuZC10by1lbmQgdmFsaWRhdGlvbiBmb3IgdGhlIHNlbGVjdGVkIHByaW9yaXRpZXM8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfc2VyaWYiIGlkPSJBMS5TUzIucDIucGljMS4yLjIzLjEuMSI+Cjwvc3Bhbj48L3NwYW4+PC9zcGFuPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj48L2ZvcmVpZ25vYmplY3Q+PC9nPjwvZz48L3N2Zz4=)

![](data:image/svg+xml;base64,PHN2ZyBjbGFzcz0ibHR4X3BpY3R1cmUiIGhlaWdodD0iOTM1LjIiIGlkPSJBMS5TUzIucDMucGljMSIgb3ZlcmZsb3c9InZpc2libGUiIHZlcnNpb249IjEuMSIgdmlld2JveD0iMCAwIDY1My4xNSA5MzUuMiIgd2lkdGg9IjY1My4xNSI+PGcgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBzdHJva2Utd2lkdGg9IjAuNHB0IiBzdHlsZT0iLS1sdHgtc3Ryb2tlLWNvbG9yOiMwMDAwMDA7LS1sdHgtZmlsbC1jb2xvcjojMDAwMDAwOyIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCw5MzUuMikgbWF0cml4KDEgMCAwIC0xIDAgMCkiPjxnIGZpbGw9IiMwMDAwMDAiIGZpbGwtb3BhY2l0eT0iMS4wIiBzdHlsZT0iLS1sdHgtZmlsbC1jb2xvcjojMDAwMDAwOyI+PHBhdGggZD0iTSAwIDMuNzQgTCAwIDkzMS40NyBDIDAgOTMzLjUzIDEuNjcgOTM1LjIgMy43NCA5MzUuMiBMIDY0OS40MSA5MzUuMiBDIDY1MS40OCA5MzUuMiA2NTMuMTUgOTMzLjUzIDY1My4xNSA5MzEuNDcgTCA2NTMuMTUgMy43NCBDIDY1My4xNSAxLjY3IDY1MS40OCAwIDY0OS40MSAwIEwgMy43NCAwIEMgMS42NyAwIDAgMS42NyAwIDMuNzQgWiIgc3R5bGU9InN0cm9rZTpub25lIiAvPjwvZz48ZyBmaWxsPSIjRjJGMkYyIiBmaWxsLW9wYWNpdHk9IjEuMCIgc3R5bGU9Ii0tbHR4LWZpbGwtY29sb3I6I0YyRjJGMjsiPjxwYXRoIGQ9Ik0gMC45NyAzLjc0IEwgMC45NyA5MTMuMDkgTCA2NTIuMTggOTEzLjA5IEwgNjUyLjE4IDMuNzQgQyA2NTIuMTggMi4yMSA2NTAuOTQgMC45NyA2NDkuNDEgMC45NyBMIDMuNzQgMC45NyBDIDIuMjEgMC45NyAwLjk3IDIuMjEgMC45NyAzLjc0IFoiIHN0eWxlPSJzdHJva2U6bm9uZSIgLz48L2c+PGcgZmlsbC1vcGFjaXR5PSIxLjAiIHRyYW5zZm9ybT0ibWF0cml4KDEuMCAwLjAgMC4wIDEuMCAxNC41OSA5MjAuNjkpIj48Zm9yZWlnbm9iamVjdCBoZWlnaHQ9IjEyLjMiIG92ZXJmbG93PSJ2aXNpYmxlIiBzdHlsZT0iLS1sdHgtZm8td2lkdGg6NDAuOTllbTstLWx0eC1mby1oZWlnaHQ6MC42OWVtOy0tbHR4LWZvLWRlcHRoOjAuMTllbTtmb250LXNpemU6MTBwdDsiIHRyYW5zZm9ybT0ibWF0cml4KDEgMCAwIC0xIDAgOS42MSkiIHdpZHRoPSI1NjcuMTkiPjxzcGFuIGNsYXNzPSJsdHhfZm9yZWlnbm9iamVjdF9jb250YWluZXIiPjxzcGFuIGNsYXNzPSJsdHhfZm9yZWlnbm9iamVjdF9jb250ZW50Ij4KPHNwYW4gY2xhc3M9Imx0eF9pbmxpbmUtYmxvY2sgbHR4X21pbmlwYWdlIGx0eF9hbGlnbl9ib3R0b20iIGlkPSJBMS5TUzIucDMucGljMS4xIiBzdHlsZT0id2lkdGg6NDAuOTllbTsiPgo8c3BhbiBjbGFzcz0ibHR4X3AiIGlkPSJBMS5TUzIucDMucGljMS4xLjEiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9zYW5zc2VyaWYgbHR4X2ZvbnRfYm9sZCIgaWQ9IkExLlNTMi5wMy5waWMxLjEuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6I0ZGRkZGRjsiPkRldmVsb3BlciBQcm9tcHQ8L3NwYW4+PC9zcGFuPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj48L2ZvcmVpZ25vYmplY3Q+PC9nPjxnIGZpbGwtb3BhY2l0eT0iMS4wIiB0cmFuc2Zvcm09Im1hdHJpeCgxLjAgMC4wIDAuMCAxLjAgMTQuNTkgMTUuNjMpIj48Zm9yZWlnbm9iamVjdCBoZWlnaHQ9Ijg4Ny42NSIgb3ZlcmZsb3c9InZpc2libGUiIHN0eWxlPSItLWx0eC1mby13aWR0aDo0OC43NWVtOy0tbHR4LWZvLWhlaWdodDo2My45OGVtOy0tbHR4LWZvLWRlcHRoOjAuMThlbTtmb250LXNpemU6MTBwdDsiIHRyYW5zZm9ybT0ibWF0cml4KDEgMCAwIC0xIDAgODg1LjIzKSIgd2lkdGg9IjY3NC41NiI+PHNwYW4gY2xhc3M9Imx0eF9mb3JlaWdub2JqZWN0X2NvbnRhaW5lciI+PHNwYW4gY2xhc3M9Imx0eF9mb3JlaWdub2JqZWN0X2NvbnRlbnQiPgo8c3BhbiBjbGFzcz0ibHR4X2lubGluZS1ibG9jayBsdHhfbWluaXBhZ2UgbHR4X2FsaWduX2JvdHRvbSIgaWQ9IkExLlNTMi5wMy5waWMxLjIiIHN0eWxlPSJ3aWR0aDo0OC43NWVtOyI+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X2JvbGQiIGlkPSJBMS5TUzIucDMucGljMS4yLjEuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7LS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPlRlbXBsYXRlIGFzc2VtYmx5LjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9tZWRpdW0iIGlkPSJBMS5TUzIucDMucGljMS4yLjEuMS4xIj7igIM8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMS4xLjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5bYmVuY2htYXJrIGd1aWRhbmNlXTwvc3Bhbj4KPG1hdGggYWx0dGV4dD0iXG9wbHVzIiBjbGFzcz0ibHR4X01hdGgiIGRpc3BsYXk9ImlubGluZSIgaWQ9IkExLlNTMi5wMy5waWMxLm0xIiBpbnRlbnQ9IjpsaXRlcmFsIj48c2VtYW50aWNzPjxtbyBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+4oqVPC9tbz48YW5ub3RhdGlvbiBlbmNvZGluZz0iYXBwbGljYXRpb24veC10ZXgiPlxvcGx1czwvYW5ub3RhdGlvbj48L3NlbWFudGljcz48L21hdGg+CjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4xLjEuMS4yIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPltpdGVyYXRpb24gd3JhcHBlcl08L3NwYW4+CjxtYXRoIGFsdHRleHQ9IlxvcGx1cyIgY2xhc3M9Imx0eF9NYXRoIiBkaXNwbGF5PSJpbmxpbmUiIGlkPSJBMS5TUzIucDMucGljMS5tMiIgaW50ZW50PSI6bGl0ZXJhbCI+PHNlbWFudGljcz48bW8gbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPuKKlTwvbW8+PGFubm90YXRpb24gZW5jb2Rpbmc9ImFwcGxpY2F0aW9uL3gtdGV4Ij5cb3BsdXM8L2Fubm90YXRpb24+PC9zZW1hbnRpY3M+PC9tYXRoPgo8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMS4xLjEuMyIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5bd2FybS1zdGFydCBibG9ja108L3NwYW4+CjxtYXRoIGFsdHRleHQ9IlxvcGx1cyIgY2xhc3M9Imx0eF9NYXRoIiBkaXNwbGF5PSJpbmxpbmUiIGlkPSJBMS5TUzIucDMucGljMS5tMyIgaW50ZW50PSI6bGl0ZXJhbCI+PHNlbWFudGljcz48bW8gbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPuKKlTwvbW8+PGFubm90YXRpb24gZW5jb2Rpbmc9ImFwcGxpY2F0aW9uL3gtdGV4Ij5cb3BsdXM8L2Fubm90YXRpb24+PC9zZW1hbnRpY3M+PC9tYXRoPgo8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMS4xLjEuNCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5bZGV2ZWxvcG1lbnQgZG9jdW1lbnRdPC9zcGFuPjwvc3Bhbj48L3NwYW4+PC9zcGFuPgo8c3BhbiBjbGFzcz0ibHR4X3AgbHR4X2FsaWduX2xlZnQiIGlkPSJBMS5TUzIucDMucGljMS4yLjIiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9ib2xkIiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4yLjEiIHN0eWxlPSJmb250LXNpemU6OTAlOy0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5NZXRob2QgY29ycmVzcG9uZGVuY2UuPHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X21lZGl1bSIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMi4xLjEiPuKAgzxtYXRoIGFsdHRleHQ9IlxsZWZ0KEFfe3QtMX07XG1hdGhjYWx7U30sRF97dH1ccmlnaHQpXHhyaWdodGFycm93e1xtYXRocm17RGV2fV97SH19QV97dH0iIGNsYXNzPSJsdHhfTWF0aCIgZGlzcGxheT0iaW5saW5lIiBpZD0iQTEuU1MyLnAzLnBpYzEubTQiIGludGVudD0iOmxpdGVyYWwiPjxzZW1hbnRpY3M+PG1yb3c+PG1yb3c+PG1vIG1hdGhjb2xvcj0iIzAwMDAwMCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4oPC9tbz48bXN1Yj48bWkgbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPkE8L21pPjxtcm93PjxtaSBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+dDwvbWk+PG1vIG1hdGhjb2xvcj0iIzAwMDAwMCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij7iiJI8L21vPjxtbiBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+MTwvbW4+PC9tcm93PjwvbXN1Yj48bW8gbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPiw8L21vPjxtaSBjbGFzcz0ibHR4X2ZvbnRfbWF0aGNhbGlncmFwaGljIiBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+8J2SrjwvbWk+PG1vIG1hdGhjb2xvcj0iIzAwMDAwMCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4sPC9tbz48bXN1Yj48bWkgbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPkQ8L21pPjxtaSBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+dDwvbWk+PC9tc3ViPjxtbyBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+KTwvbW8+PC9tcm93Pjxtb3ZlciBhY2NlbnQ9InRydWUiPjxtbyBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+4oaSPC9tbz48bXN1Yj48bWkgbWF0aGNvbG9yPSIjMDAwMDAwIiBtYXRoc2l6ZT0iMC43MDBlbSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5EZXY8L21pPjxtaSBtYXRoY29sb3I9IiMwMDAwMDAiIG1hdGhzaXplPSIwLjcxMGVtIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPkg8L21pPjwvbXN1Yj48L21vdmVyPjxtc3ViPjxtaSBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+QTwvbWk+PG1pIG1hdGhjb2xvcj0iIzAwMDAwMCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij50PC9taT48L21zdWI+PC9tcm93Pjxhbm5vdGF0aW9uIGVuY29kaW5nPSJhcHBsaWNhdGlvbi94LXRleCI+XGxlZnQoQV97dC0xfTtcbWF0aGNhbHtTfSxEX3t0fVxyaWdodClceHJpZ2h0YXJyb3d7XG1hdGhybXtEZXZ9X3tIfX1BX3t0fTwvYW5ub3RhdGlvbj48L3NlbWFudGljcz48L21hdGg+PC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMyI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDMucGljMS4yLjMuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7Ij4vcm9sZS9kZXZlbG9wZXI8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfc2VyaWYiIGlkPSJBMS5TUzIucDMucGljMS4yLjMuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAzLnBpYzEuMi40Ij48c3BhbiBjbGFzcz0ibHR4X3RleHQiIGlkPSJBMS5TUzIucDMucGljMS4yLjQuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7LS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPllvdSBhcmUgdGhlIERldmVsb3BlciBmb3IgaXRlcmF0aW9uIDxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAzLnBpYzEuMi40LjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij57e2xvb3BfaW5kZXh9fTwvc3Bhbj4uIEJ1aWxkIG9yIGltcHJvdmUKdGhlIGNvbXBsZXRlIHByb2plY3QgYXQgPHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDMucGljMS4yLjQuMS4yIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPi93b3Jrc3BhY2UvZ2FtZTwvc3Bhbj4KLiBUcmVhdCB0aGUgcHVibGljIHRhc2sKaW5zdHJ1Y3Rpb24gYXMgdGhlIFBSRCBhbmQgdGhlIGN1cnJlbnQgZGV2ZWxvcG1lbnQgZG9jdW1lbnQgYXMgdGhlCmltcGxlbWVudGF0aW9uIGFuZCB2YWxpZGF0aW9uIGJyaWVmIGZvciB0aGlzIGl0ZXJhdGlvbi48L3NwYW4+PC9zcGFuPgo8c3BhbiBjbGFzcz0ibHR4X3AgbHR4X2FsaWduX2xlZnQiIGlkPSJBMS5TUzIucDMucGljMS4yLjUiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAzLnBpYzEuMi41LjEiIHN0eWxlPSJmb250LXNpemU6OTAlOyI+L2l0ZXJhdGlvbi1jb250ZXh0PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3NlcmlmIiBpZD0iQTEuU1MyLnAzLnBpYzEuMi41LjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMy5waWMxLjIuNiI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDMucGljMS4yLjYuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7LS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPiMgT3V0ZXItbG9vcCBhdHRlbXB0IDxzcGFuIGNsYXNzPSJsdHhfdGV4dCIgaWQ9IkExLlNTMi5wMy5waWMxLjIuNi4xLjEiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+e3thdHRlbXB0fX08L3NwYW4+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3NlcmlmIiBpZD0iQTEuU1MyLnAzLnBpYzEuMi42LjEuMiI+Cjwvc3Bhbj48L3NwYW4+PC9zcGFuPgo8c3BhbiBjbGFzcz0ibHR4X3AgbHR4X2FsaWduX2xlZnQiIGlkPSJBMS5TUzIucDMucGljMS4yLjciPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAzLnBpYzEuMi43LjEiIHN0eWxlPSJmb250LXNpemU6OTAlOyI+W2lmIHdhcm0tc3RhcnRlZDoge3t3YXJtX3N0YXJ0X3NlY3Rpb259fV08c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfc2VyaWYiIGlkPSJBMS5TUzIucDMucGljMS4yLjcuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAzLnBpYzEuMi44Ij48c3BhbiBjbGFzcz0ibHR4X3RleHQiIGlkPSJBMS5TUzIucDMucGljMS4yLjguMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7LS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPkNvbnRpbnVlIGZyb20gdGhlIGFydGlmYWN0IGFscmVhZHkgcHJlc2VudCBpbiA8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMy5waWMxLjIuOC4xLjEiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+L3dvcmtzcGFjZS9nYW1lPC9zcGFuPgouClByZXNlcnZlIHZlcmlmaWVkIGZ1bmN0aW9uYWxpdHkgYW5kIHJlcGFpciB0aGUgbmV4dCBvYnNlcnZhYmxlIGdhcCByYXRoZXIgdGhhbgpyZXBsYWNpbmcgYSB3b3JraW5nIHByb2plY3Qgd2l0aCBhIHNtYWxsZXIgcmVzZXQuPC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAzLnBpYzEuMi45Ij48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMy5waWMxLjIuOS4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTsiPi9kZXZlbG9wbWVudC1kb2N1bWVudDxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9zZXJpZiIgaWQ9IkExLlNTMi5wMy5waWMxLjIuOS4xLjEiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+Cjwvc3Bhbj48L3NwYW4+PC9zcGFuPgo8c3BhbiBjbGFzcz0ibHR4X3AgbHR4X2FsaWduX2xlZnQiIGlkPSJBMS5TUzIucDMucGljMS4yLjEwIj48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMTAuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7LS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPkN1cnJlbnQgZG9jdW1lbnQ6IDxzcGFuIGNsYXNzPSJsdHhfdGV4dCIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMTAuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPnt7ZGV2ZWxvcG1lbnRfZG9jX2ZpbGVuYW1lfX08L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4xMSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDMucGljMS4yLjExLjEiIHN0eWxlPSJmb250LXNpemU6OTAlOy0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5QbGFubmluZyBpbnB1dHM6IDxzcGFuIGNsYXNzPSJsdHhfdGV4dCIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMTEuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPnt7cGxhbm5pbmdfaW5wdXRzfX08L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4xMiI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDMucGljMS4yLjEyLjEiIHN0eWxlPSJmb250LXNpemU6OTAlOy0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5CdWlsZCBzdGF0dXM6IDxzcGFuIGNsYXNzPSJsdHhfdGV4dCIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMTIuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPnt7YnVpbGRfb2t9fTwvc3Bhbj48L3NwYW4+PC9zcGFuPgo8c3BhbiBjbGFzcz0ibHR4X3AgbHR4X2FsaWduX2xlZnQiIGlkPSJBMS5TUzIucDMucGljMS4yLjEzIj48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMTMuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7LS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPk9ic2VydmVkIGRlbW9zOiA8c3BhbiBjbGFzcz0ibHR4X3RleHQiIGlkPSJBMS5TUzIucDMucGljMS4yLjEzLjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij57e251bV9kZW1vc319PC9zcGFuPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9zZXJpZiIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMTMuMS4yIj4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMTQiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4xNC4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTsiPnt7cHVibGljX3Rhc2tfaW5zdHJ1Y3Rpb259fTxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9zZXJpZiIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMTQuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4xNSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDMucGljMS4yLjE1LjEiIHN0eWxlPSJmb250LXNpemU6OTAlOyI+e3tmb2N1c19pdGVtc319PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3NlcmlmIiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4xNS4xLjEiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+Cjwvc3Bhbj48L3NwYW4+PC9zcGFuPgo8c3BhbiBjbGFzcz0ibHR4X3AgbHR4X2FsaWduX2xlZnQiIGlkPSJBMS5TUzIucDMucGljMS4yLjE2Ij48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMTYuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7Ij57e3ByZXNlcnZlX3Zpc2libGVfc2VjdGlvbn19PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3NlcmlmIiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4xNi4xLjEiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+Cjwvc3Bhbj48L3NwYW4+PC9zcGFuPgo8c3BhbiBjbGFzcz0ibHR4X3AgbHR4X2FsaWduX2xlZnQiIGlkPSJBMS5TUzIucDMucGljMS4yLjE3Ij48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMTcuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7Ij57e2RldmVsb3BtZW50X2JyaWVmfX08c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfc2VyaWYiIGlkPSJBMS5TUzIucDMucGljMS4yLjE3LjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMTgiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4xOC4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTsiPnt7ZXZpZGVuY2VfaGlzdG9yeV9zZWN0aW9ufX08c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfc2VyaWYiIGlkPSJBMS5TUzIucDMucGljMS4yLjE4LjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMTkiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4xOS4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTsiPi9kZXZlbG9wbWVudC1wb2xpY3k8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfc2VyaWYiIGlkPSJBMS5TUzIucDMucGljMS4yLjE5LjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMjAiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMjAuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7LS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPlJlcGFpciBidWlsZCBhbmQgcnVudGltZSBibG9ja2VycyBmaXJzdCwgdGhlbiBhZGRyZXNzIHRoZSBvcmRlcmVkIHRhcmdldHMgaW4KdGhlIGRvY3VtZW50LiBVc2UgdGhlIGhhcm5lc3PigJlzIG5hdGl2ZSBmaWxlLCByZXBvc2l0b3J5LCBzaGVsbCwgYnVpbGQsCmV4ZWN1dGlvbiwgYW5kIGxvY2FsLXRlc3RpbmcgdG9vbHMuIEtlZXAgdGhlIHByb2plY3QgbGF1bmNoYWJsZSBhbmQgbWFrZSBldmVyeQpjbGFpbWVkIG1lY2hhbmljIG9ic2VydmFibGUgdGhyb3VnaCBhIHZhbGlkIHJlcGxheSB0cmFjZS4gUHVibGljIGFzc2V0cyBtYXkgYmUKcmVhZCBmcm9tIDxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4yMC4xLjEiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+L3dvcmtzcGFjZS9hc3NldHMvbGlicmFyeTwvc3Bhbj4KIGFuZAo8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMjAuMS4yIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPi93b3Jrc3BhY2UvYXNzZXRzL2xpYnJhcnktb2dhPC9zcGFuPgo7IGNvcGllZCBhc3NldHMgY291bnQgb25seSB3aGVuIHRoZXkKYXJlIHZpc2libHkgdXNlZCBieSB0aGUgYXJ0aWZhY3QuPC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4yMSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDMucGljMS4yLjIxLjEiIHN0eWxlPSJmb250LXNpemU6OTAlOyI+L291dHB1dC1jb250cmFjdDxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9zZXJpZiIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMjEuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4yMiI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4yMi4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTstLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+TGVhdmUgdGhlIHVwZGF0ZWQgYXJ0aWZhY3QgaW4gPHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDMucGljMS4yLjIyLjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4vd29ya3NwYWNlL2dhbWU8L3NwYW4+CiwgaW5jbHVkaW5nCjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnAzLnBpYzEuMi4yMi4xLjIiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+L3dvcmtzcGFjZS9nYW1lL3Byb2plY3QuZ29kb3Q8L3NwYW4+CiwgYSBsYXVuY2hhYmxlIG1haW4gc2NlbmUsIGFuZCB2YWxpZAo8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wMy5waWMxLjIuMjIuMS4zIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPi93b3Jrc3BhY2UvZ2FtZS9kZW1vX291dHB1dHMvKi5qc29uPC9zcGFuPgogdHJhY2VzLiBQcmVzZXJ2ZSB0aGUgcHVibGljCnJ1bnRpbWUgcmVjb3JkcyByZXF1aXJlZCBmb3IgUUEgdGVzdGluZy48L3NwYW4+PC9zcGFuPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj48L2ZvcmVpZ25vYmplY3Q+PC9nPjwvZz48L3N2Zz4=)

![](data:image/svg+xml;base64,PHN2ZyBjbGFzcz0ibHR4X3BpY3R1cmUiIGhlaWdodD0iODcyLjkzIiBpZD0iQTEuU1MyLnA0LnBpYzEiIG92ZXJmbG93PSJ2aXNpYmxlIiB2ZXJzaW9uPSIxLjEiIHZpZXdib3g9IjAgMCA2NTMuMTUgODcyLjkzIiB3aWR0aD0iNjUzLjE1Ij48ZyBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHN0cm9rZS13aWR0aD0iMC40cHQiIHN0eWxlPSItLWx0eC1zdHJva2UtY29sb3I6IzAwMDAwMDstLWx0eC1maWxsLWNvbG9yOiMwMDAwMDA7IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLDg3Mi45MykgbWF0cml4KDEgMCAwIC0xIDAgMCkiPjxnIGZpbGw9IiMwMDAwMDAiIGZpbGwtb3BhY2l0eT0iMS4wIiBzdHlsZT0iLS1sdHgtZmlsbC1jb2xvcjojMDAwMDAwOyI+PHBhdGggZD0iTSAwIDMuNzQgTCAwIDg2OS4yIEMgMCA4NzEuMjYgMS42NyA4NzIuOTMgMy43NCA4NzIuOTMgTCA2NDkuNDEgODcyLjkzIEMgNjUxLjQ4IDg3Mi45MyA2NTMuMTUgODcxLjI2IDY1My4xNSA4NjkuMiBMIDY1My4xNSAzLjc0IEMgNjUzLjE1IDEuNjcgNjUxLjQ4IDAgNjQ5LjQxIDAgTCAzLjc0IDAgQyAxLjY3IDAgMCAxLjY3IDAgMy43NCBaIiBzdHlsZT0ic3Ryb2tlOm5vbmUiIC8+PC9nPjxnIGZpbGw9IiNGMEYwRjAiIGZpbGwtb3BhY2l0eT0iMS4wIiBzdHlsZT0iLS1sdHgtZmlsbC1jb2xvcjojRjBGMEYwOyI+PHBhdGggZD0iTSAwLjk3IDMuNzQgTCAwLjk3IDg1MC44MiBMIDY1Mi4xOCA4NTAuODIgTCA2NTIuMTggMy43NCBDIDY1Mi4xOCAyLjIxIDY1MC45NCAwLjk3IDY0OS40MSAwLjk3IEwgMy43NCAwLjk3IEMgMi4yMSAwLjk3IDAuOTcgMi4yMSAwLjk3IDMuNzQgWiIgc3R5bGU9InN0cm9rZTpub25lIiAvPjwvZz48ZyBmaWxsLW9wYWNpdHk9IjEuMCIgdHJhbnNmb3JtPSJtYXRyaXgoMS4wIDAuMCAwLjAgMS4wIDE0LjU5IDg1OC40MikiPjxmb3JlaWdub2JqZWN0IGhlaWdodD0iMTIuMyIgb3ZlcmZsb3c9InZpc2libGUiIHN0eWxlPSItLWx0eC1mby13aWR0aDo0MC45OWVtOy0tbHR4LWZvLWhlaWdodDowLjY5ZW07LS1sdHgtZm8tZGVwdGg6MC4xOWVtO2ZvbnQtc2l6ZToxMHB0OyIgdHJhbnNmb3JtPSJtYXRyaXgoMSAwIDAgLTEgMCA5LjYxKSIgd2lkdGg9IjU2Ny4xOSI+PHNwYW4gY2xhc3M9Imx0eF9mb3JlaWdub2JqZWN0X2NvbnRhaW5lciI+PHNwYW4gY2xhc3M9Imx0eF9mb3JlaWdub2JqZWN0X2NvbnRlbnQiPgo8c3BhbiBjbGFzcz0ibHR4X2lubGluZS1ibG9jayBsdHhfbWluaXBhZ2UgbHR4X2FsaWduX2JvdHRvbSIgaWQ9IkExLlNTMi5wNC5waWMxLjEiIHN0eWxlPSJ3aWR0aDo0MC45OWVtOyI+CjxzcGFuIGNsYXNzPSJsdHhfcCIgaWQ9IkExLlNTMi5wNC5waWMxLjEuMSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3NhbnNzZXJpZiBsdHhfZm9udF9ib2xkIiBpZD0iQTEuU1MyLnA0LnBpYzEuMS4xLjEiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojRkZGRkZGOyI+UUEgVGVzdGVyIFByb21wdDwvc3Bhbj48L3NwYW4+Cjwvc3Bhbj48L3NwYW4+PC9zcGFuPjwvZm9yZWlnbm9iamVjdD48L2c+PGcgZmlsbC1vcGFjaXR5PSIxLjAiIHRyYW5zZm9ybT0ibWF0cml4KDEuMCAwLjAgMC4wIDEuMCAxNC41OSAxNi4zMikiPjxmb3JlaWdub2JqZWN0IGhlaWdodD0iODI1LjM5IiBvdmVyZmxvdz0idmlzaWJsZSIgc3R5bGU9Ii0tbHR4LWZvLXdpZHRoOjQ4Ljc1ZW07LS1sdHgtZm8taGVpZ2h0OjU5LjQzZW07LS1sdHgtZm8tZGVwdGg6MC4yM2VtO2ZvbnQtc2l6ZToxMHB0OyIgdHJhbnNmb3JtPSJtYXRyaXgoMSAwIDAgLTEgMCA4MjIuMjcpIiB3aWR0aD0iNjc0LjU2Ij48c3BhbiBjbGFzcz0ibHR4X2ZvcmVpZ25vYmplY3RfY29udGFpbmVyIj48c3BhbiBjbGFzcz0ibHR4X2ZvcmVpZ25vYmplY3RfY29udGVudCI+CjxzcGFuIGNsYXNzPSJsdHhfaW5saW5lLWJsb2NrIGx0eF9taW5pcGFnZSBsdHhfYWxpZ25fYm90dG9tIiBpZD0iQTEuU1MyLnA0LnBpYzEuMiIgc3R5bGU9IndpZHRoOjQ4Ljc1ZW07Ij4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xIj48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfYm9sZCIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMS4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTstLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+VGVtcGxhdGUgYXNzZW1ibHkuPHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X21lZGl1bSIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMS4xLjEiPuKAgzxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xLjEuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPlt0ZXN0ZXIgcm9sZV08L3NwYW4+CjxtYXRoIGFsdHRleHQ9IlxvcGx1cyIgY2xhc3M9Imx0eF9NYXRoIiBkaXNwbGF5PSJpbmxpbmUiIGlkPSJBMS5TUzIucDQucGljMS5tMSIgaW50ZW50PSI6bGl0ZXJhbCI+PHNlbWFudGljcz48bW8gbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPuKKlTwvbW8+PGFubm90YXRpb24gZW5jb2Rpbmc9ImFwcGxpY2F0aW9uL3gtdGV4Ij5cb3BsdXM8L2Fubm90YXRpb24+PC9zZW1hbnRpY3M+PC9tYXRoPgo8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMS4xLjEuMiIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5bcGhhc2UgaW5zdHJ1Y3Rpb25dPC9zcGFuPgo8bWF0aCBhbHR0ZXh0PSJcb3BsdXMiIGNsYXNzPSJsdHhfTWF0aCIgZGlzcGxheT0iaW5saW5lIiBpZD0iQTEuU1MyLnA0LnBpYzEubTIiIGludGVudD0iOmxpdGVyYWwiPjxzZW1hbnRpY3M+PG1vIG1hdGhjb2xvcj0iIzAwMDAwMCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij7iipU8L21vPjxhbm5vdGF0aW9uIGVuY29kaW5nPSJhcHBsaWNhdGlvbi94LXRleCI+XG9wbHVzPC9hbm5vdGF0aW9uPjwvc2VtYW50aWNzPjwvbWF0aD4KPHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDQucGljMS4yLjEuMS4xLjMiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+W2RldmVsb3BtZW50IGRvY3VtZW50XTwvc3Bhbj4KPG1hdGggYWx0dGV4dD0iXG9wbHVzIiBjbGFzcz0ibHR4X01hdGgiIGRpc3BsYXk9ImlubGluZSIgaWQ9IkExLlNTMi5wNC5waWMxLm0zIiBpbnRlbnQ9IjpsaXRlcmFsIj48c2VtYW50aWNzPjxtbyBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+4oqVPC9tbz48YW5ub3RhdGlvbiBlbmNvZGluZz0iYXBwbGljYXRpb24veC10ZXgiPlxvcGx1czwvYW5ub3RhdGlvbj48L3NlbWFudGljcz48L21hdGg+CjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xLjEuMS40IiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPlttZWRpYSBtYW5pZmVzdF08L3NwYW4+CjxtYXRoIGFsdHRleHQ9IlxvcGx1cyIgY2xhc3M9Imx0eF9NYXRoIiBkaXNwbGF5PSJpbmxpbmUiIGlkPSJBMS5TUzIucDQucGljMS5tNCIgaW50ZW50PSI6bGl0ZXJhbCI+PHNlbWFudGljcz48bW8gbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPuKKlTwvbW8+PGFubm90YXRpb24gZW5jb2Rpbmc9ImFwcGxpY2F0aW9uL3gtdGV4Ij5cb3BsdXM8L2Fubm90YXRpb24+PC9zZW1hbnRpY3M+PC9tYXRoPgo8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMS4xLjEuNSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5bcGhhc2Utc3BlY2lmaWMgb3V0cHV0IGNvbnRyYWN0XTwvc3Bhbj48L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4yIj48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfYm9sZCIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMi4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTstLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+TWV0aG9kIGNvcnJlc3BvbmRlbmNlLjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9tZWRpdW0iIGlkPSJBMS5TUzIucDQucGljMS4yLjIuMS4xIj7igIM8bWF0aCBhbHR0ZXh0PSJcbGVmdChBX3t0fTtcbWF0aGNhbHtTfSxEX3t0fVxyaWdodClceHJpZ2h0YXJyb3d7XG1hdGhybXtUZXN0fV97SH19XG1hdGhjYWx7RX1fe3R9IiBjbGFzcz0ibHR4X01hdGgiIGRpc3BsYXk9ImlubGluZSIgaWQ9IkExLlNTMi5wNC5waWMxLm01IiBpbnRlbnQ9IjpsaXRlcmFsIj48c2VtYW50aWNzPjxtcm93Pjxtcm93PjxtbyBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+KDwvbW8+PG1zdWI+PG1pIG1hdGhjb2xvcj0iIzAwMDAwMCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5BPC9taT48bWkgbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPnQ8L21pPjwvbXN1Yj48bW8gbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPiw8L21vPjxtaSBjbGFzcz0ibHR4X2ZvbnRfbWF0aGNhbGlncmFwaGljIiBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+8J2SrjwvbWk+PG1vIG1hdGhjb2xvcj0iIzAwMDAwMCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4sPC9tbz48bXN1Yj48bWkgbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPkQ8L21pPjxtaSBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+dDwvbWk+PC9tc3ViPjxtbyBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+KTwvbW8+PC9tcm93Pjxtb3ZlciBhY2NlbnQ9InRydWUiPjxtbyBtYXRoY29sb3I9IiMwMDAwMDAiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+4oaSPC9tbz48bXN1Yj48bWkgbWF0aGNvbG9yPSIjMDAwMDAwIiBtYXRoc2l6ZT0iMC43MDBlbSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5UZXN0PC9taT48bWkgbWF0aGNvbG9yPSIjMDAwMDAwIiBtYXRoc2l6ZT0iMC43MTBlbSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5IPC9taT48L21zdWI+PC9tb3Zlcj48bXN1Yj48bWkgY2xhc3M9Imx0eF9mb250X21hdGhjYWxpZ3JhcGhpYyIgbWF0aGNvbG9yPSIjMDAwMDAwIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPuKEsDwvbWk+PG1pIG1hdGhjb2xvcj0iIzAwMDAwMCIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij50PC9taT48L21zdWI+PC9tcm93Pjxhbm5vdGF0aW9uIGVuY29kaW5nPSJhcHBsaWNhdGlvbi94LXRleCI+XGxlZnQoQV97dH07XG1hdGhjYWx7U30sRF97dH1ccmlnaHQpXHhyaWdodGFycm93e1xtYXRocm17VGVzdH1fe0h9fVxtYXRoY2Fse0V9X3t0fTwvYW5ub3RhdGlvbj48L3NlbWFudGljcz48L21hdGg+PC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMyI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDQucGljMS4yLjMuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7Ij4vcm9sZS9xYS10ZXN0ZXI8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfc2VyaWYiIGlkPSJBMS5TUzIucDQucGljMS4yLjMuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi40Ij48c3BhbiBjbGFzcz0ibHR4X3RleHQiIGlkPSJBMS5TUzIucDQucGljMS4yLjQuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7LS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPllvdSBhcmUgdGhlIFFBIFRlc3RlciBmb3IgaXRlcmF0aW9uIDxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnA0LnBpYzEuMi40LjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij57e2xvb3BfaW5kZXh9fTwvc3Bhbj4uIFJldmlldyB0aGUKdXBkYXRlZCBhcnRpZmFjdCBhcyBhIHBsYXllci1mYWNpbmcgcHJvZHVjdCB1c2luZyBvbmx5IHRoZSBwdWJsaWMgdGFzayB0ZXh0LAp0aGUgY3VycmVudCBkZXZlbG9wbWVudCBkb2N1bWVudCwgdmlzaWJsZSBwcm9qZWN0IGZpbGVzLCBzY3JlZW5zaG90cywgcmVwbGF5CnRyYWNlcywgYW5kIHZpZGVvcy4gRG8gbm90IG1vZGlmeSBwcm9kdWN0aW9uIGNvZGUuPC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi41Ij48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wNC5waWMxLjIuNS4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTsiPnt7dGVzdGVyX3BoYXNlX2luc3RydWN0aW9ufX08c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfc2VyaWYiIGlkPSJBMS5TUzIucDQucGljMS4yLjUuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi42Ij48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wNC5waWMxLjIuNi4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTsiPi9pbnB1dHM8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfc2VyaWYiIGlkPSJBMS5TUzIucDQucGljMS4yLjYuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi43Ij48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wNC5waWMxLjIuNy4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTstLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+VGFzayBkaXJlY3Rvcnk6IDxzcGFuIGNsYXNzPSJsdHhfdGV4dCIgaWQ9IkExLlNTMi5wNC5waWMxLjIuNy4xLjEiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+e3t0YXNrX2Rpcn19PC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wNC5waWMxLjIuOCI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDQucGljMS4yLjguMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7LS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPlRyaWFsOiA8c3BhbiBjbGFzcz0ibHR4X3RleHQiIGlkPSJBMS5TUzIucDQucGljMS4yLjguMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPnt7dHJpYWxfbmFtZX19PC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wNC5waWMxLjIuOSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDQucGljMS4yLjkuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7LS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPlRyaWFsIGRpcmVjdG9yeTogPHNwYW4gY2xhc3M9Imx0eF90ZXh0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi45LjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij57e3RyaWFsX2Rpcn19PC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMTAiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xMC4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTstLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+RGV2ZWxvcG1lbnQgZG9jdW1lbnQ6IDxzcGFuIGNsYXNzPSJsdHhfdGV4dCIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMTAuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPnt7ZGV2ZWxvcG1lbnRfZG9jX2ZpbGVuYW1lfX08L3NwYW4+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3NlcmlmIiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xMC4xLjIiPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xMSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDQucGljMS4yLjExLjEiIHN0eWxlPSJmb250LXNpemU6OTAlOyI+L2RldmVsb3BtZW50LWRvY3VtZW50PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3NlcmlmIiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xMS4xLjEiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+Cjwvc3Bhbj48L3NwYW4+PC9zcGFuPgo8c3BhbiBjbGFzcz0ibHR4X3AgbHR4X2FsaWduX2xlZnQiIGlkPSJBMS5TUzIucDQucGljMS4yLjEyIj48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMTIuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7Ij57e2RldmVsb3BtZW50X2RvY3VtZW50fX08c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfc2VyaWYiIGlkPSJBMS5TUzIucDQucGljMS4yLjEyLjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMTMiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xMy4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTsiPi9wdWJsaWMtdmlzdWFsLWV2aWRlbmNlPHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3NlcmlmIiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xMy4xLjEiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+Cjwvc3Bhbj48L3NwYW4+PC9zcGFuPgo8c3BhbiBjbGFzcz0ibHR4X3AgbHR4X2FsaWduX2xlZnQiIGlkPSJBMS5TUzIucDQucGljMS4yLjE0Ij48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMTQuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7Ij57e21lZGlhX2xpbmVzfX08c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfc2VyaWYiIGlkPSJBMS5TUzIucDQucGljMS4yLjE0LjEuMSIgc3R5bGU9Ii0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+CjxzcGFuIGNsYXNzPSJsdHhfcCBsdHhfYWxpZ25fbGVmdCIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMTUiPjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xNS4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTsiPi9hc3Nlc3NtZW50LXBvbGljeTxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9zZXJpZiIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMTUuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xNiI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xNi4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTstLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+RGVyaXZlIGNoZWNrYWJsZSBjbGFpbXMgZnJvbSB0aGUgcHVibGljIHJlcXVpcmVtZW50cyBhbmQgdmFsaWRhdGlvbiB0YXJnZXRzLgpBc3NpZ24gYSBjbGFpbeKAk2V2aWRlbmNlIHJlY29yZCB0byB0aGUgdmVyaWZpZWQgc3Vic2V0IG9ubHkgd2hlbiB0aGUgY2l0ZWQKZXhlY3V0aW9uIHJlY29yZHMgcHJvdmlkZSBzdWZmaWNpZW50IG9ic2VydmFibGUgc3VwcG9ydC4gUmVjb3JkIHZpc2libGUKZmFpbHVyZXMsIHJlZ3Jlc3Npb25zLCB1bm1ldCByZXF1aXJlbWVudHMsIGFuZCBpbnN1ZmZpY2llbnQgZXZpZGVuY2UgYXMgZ2Fwcy4KSW5zcGVjdCByZXBsYXkgZXZlbnQgdHlwZXMgYW5kIHJlamVjdCB0cmFjZXMgdGhhdCBjYW5ub3QgYmUgcmVwcm9kdWNlZCB0aHJvdWdoCnRoZSBwdWJsaWMgbW91c2UsIGtleWJvYXJkLCBhbmQgd2FpdC1ldmVudCBpbnRlcmZhY2UuPC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xNyI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDQucGljMS4yLjE3LjEiIHN0eWxlPSJmb250LXNpemU6OTAlOyI+L3Jlc3RyaWN0aW9uczxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9zZXJpZiIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMTcuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xOCI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xOC4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTstLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+RG8gbm90IHJlYWQsIGxpc3QsIGluZmVyIGZyb20sIG9yIHN1bW1hcml6ZSA8c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMTguMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPi90ZXN0czwvc3Bhbj4KLCBiZW5jaG1hcmsKc2NvcmVzLCBwcml2YXRlIGV2YWx1YXRvciBmaWxlcywgaGlkZGVuIHRhc2sgbWV0YWRhdGEsIGZvcm11bGFzLCBvciBob3N0LW9ubHkKbWF0ZXJpYWxzIG91dHNpZGUgdGhlIHB1YmxpYyB0YXNrIGFuZCBnZW5lcmF0ZWQgYXJ0aWZhY3QuPC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4xOSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDQucGljMS4yLjE5LjEiIHN0eWxlPSJmb250LXNpemU6OTAlOyI+L291dHB1dC1jb250cmFjdDxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9zZXJpZiIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMTkuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPHNwYW4gY2xhc3M9Imx0eF9wIGx0eF9hbGlnbl9sZWZ0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4yMCI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4yMC4xIiBzdHlsZT0iZm9udC1zaXplOjkwJTstLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+V3JpdGUgPHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3R5cGV3cml0ZXIiIGlkPSJBMS5TUzIucDQucGljMS4yLjIwLjEuMSI+dmlzdWFsX3BsYXl0ZXN0X3JlcG9ydC5tZDwvc3Bhbj4gYW5kCjxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF90eXBld3JpdGVyIiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4yMC4xLjIiPnZpc3VhbF9wbGF5dGVzdF9yZXBvcnQuanNvbjwvc3Bhbj4uIEVhY2ggcmVwb3J0IHJlY29yZHMgc3RhdHVzLCBjaXRlZApldmlkZW5jZSwgcGxheWVyIGltcGFjdCwgaXNzdWUgb3duZXJzaGlwLCBhbmQgYSBjb25jcmV0ZSByZWNvbW1lbmRhdGlvbi48L3NwYW4+PC9zcGFuPgo8c3BhbiBjbGFzcz0ibHR4X3AgbHR4X2FsaWduX2xlZnQiIGlkPSJBMS5TUzIucDQucGljMS4yLjIxIj48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMjEuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7Ij5bbmV4dC1sb29wIHBoYXNlOiByZW1haW5pbmcgYnVncywgcHJlc2VydmF0aW9uIHJlY29yZHMsIGFuZApuZXh0LWxvb3AgZ29hbHNdPHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3NlcmlmIiBpZD0iQTEuU1MyLnA0LnBpYzEuMi4yMS4xLjEiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojMDAwMDAwOyI+Cjwvc3Bhbj48L3NwYW4+PC9zcGFuPgo8c3BhbiBjbGFzcz0ibHR4X3AgbHR4X2FsaWduX2xlZnQiIGlkPSJBMS5TUzIucDQucGljMS4yLjIyIj48c3BhbiBjbGFzcz0ibHR4X3RleHQgbHR4X2ZvbnRfdHlwZXdyaXRlciIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMjIuMSIgc3R5bGU9ImZvbnQtc2l6ZTo5MCU7Ij57e3Rlc3Rlcl9waGFzZV9vdXRwdXRfY29udHJhY3R9fTxzcGFuIGNsYXNzPSJsdHhfdGV4dCBsdHhfZm9udF9zZXJpZiIgaWQ9IkExLlNTMi5wNC5waWMxLjIuMjIuMS4xIiBzdHlsZT0iLS1sdHgtZmctY29sb3I6IzAwMDAwMDsiPgo8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+PC9mb3JlaWdub2JqZWN0PjwvZz48L2c+PC9zdmc+)

The QA prompt requests evidence-bearing findings in a benchmark-appropriate JSON report. The report need not reproduce the mathematical tuple notation verbatim. After the QA invocation, the benchmark adapter normalizes its claims, cited execution records, and statuses into the evidence bundle $\mathcal{E}_{t}$ used in the main paper. Thus, ${Test}_{H}$ denotes the complete testing interface, including both evidence collection by the QA Tester and deterministic normalization of its report.

### A.3 Development Tools and Workspace Operations

HoH does not replace the tools exposed by the underlying coding harness. Instead, the Developer uses those tools under the current development document and writes all changes to the same project workspace. The workspace contains source code, configuration, project resources, and any public runtime artifacts produced during development. Warm-starting therefore preserves not only source files but also the project structure and resources required to continue development from $A_{t - 1}$.

Table [5](#A1.T5 "Table 5 ‣ A.3 Development Tools and Workspace Operations ‣ Appendix A Method and Implementation Details ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") summarizes the principal capabilities used by the implementation. The exact commands depend on the selected harness and benchmark, but the role of each capability is fixed across iterations.

|  Capability           |  Representative operations                                                                                   |  Retained records                                                |
|-----------------------|--------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------|
|  Project operations   |  Inspect and edit source files, configuration, assets, and repository state                                  |  Updated files and change state                                  |
|  Build and execution  |  Invoke shell commands, build the project, launch the artifact, and run public local checks                  |  Exit status, standard output, standard error, and runtime logs  |
|  Game interaction     |  Launch Godot scenes, exercise controls, and execute deterministic interaction traces                        |  Replay traces and observable state transitions                  |
|  Visual inspection    |  Capture screenshots or videos and inspect visible asset use, interface state, feedback, and result screens  |  Media manifest and referenced frames                            |
|  Task-specific tools  |  Use public benchmark containers, dependencies, and task-provided verification utilities where available     |  Public test and execution results                               |

Table 5: Development and inspection capabilities used by HoH. Private benchmark evaluators and their outputs are excluded from these interfaces.

For GameCraft-Bench, $A_{t}$ is a Godot project containing source scripts, scenes, configuration, assets, and replay outputs. The benchmark adapter materializes the current development document as additional context for the Developer and records the harness command, process outcome, and resulting trial. For FrontierSWE, the same interfaces operate on the task repository and its public execution environment. Benchmark-specific adapters change how an artifact is launched and observed; they do not change the planning, coding, or testing roles.

### A.4 Evidence Collection and Representation

The QA stage and benchmark adapter together convert observable behavior into the claim–evidence records defined in the main paper. The correspondence is

|     |                   |                                                                                      |     |     |
|-----|-------------------|--------------------------------------------------------------------------------------|-----|-----|
|     | $\mathcal{C}_{t}$ | ${\phantom{} = {{Claims}{(\mathcal{S},D_{t})}}},$                                    |     | (4) |
|     | $r_{i}$           | ${\phantom{} = {{Observe}{(A_{t},c_{i})}}},$                                         |     |     |
|     | $s_{i}$           | ${\phantom{} = {{Assess}{(c_{i},r_{i})}}},$                                          |     |     |
|     | $\mathcal{E}_{t}$ | ${\phantom{} = \left\{ {(c_{i},r_{i},s_{i})} \right\}_{c_{i} \in \mathcal{C}_{t}}}.$ |     |     |

Here, $\mathcal{C}_{t}$ contains the checkable claims, $r_{i}$ denotes the public execution records collected for claim $c_{i}$, and $s_{i}$ is the normalized QA status. Claims are instantiated from the public requirements, current development targets, preservation constraints, and validation requirements.

Evidence collection first executes or inspects the artifact using the capabilities above. Build and test outcomes establish whether the artifact can run; runtime logs and traces expose state transitions; screenshots, videos, and replays provide player-visible observations; and asset inspection determines whether project resources are used in the executed artifact. Source-code presence alone is not treated as behavioral verification.

The QA Tester then assesses every claim against its cited records. A record is placed in $\mathcal{E}_{t}^{ver}$ only when the evidence visibly supports the corresponding claim. Observed failures, unmet requirements, regression risks, and claims without sufficient evidence are placed in $\mathcal{E}_{t}^{gap}$. Formally, the two subsets are

|     |                         |                                                                                                        |     |     |
|-----|-------------------------|--------------------------------------------------------------------------------------------------------|-----|-----|
|     | $\mathcal{E}_{t}^{ver}$ | ${\phantom{} = \left\{ {{(c_{i},r_{i},s_{i})} \in \mathcal{E}_{t}}\mid{s_{i} = {verified}} \right\}},$ |     | (5) |
|     | $\mathcal{E}_{t}^{gap}$ | ${\phantom{} = \left\{ {{(c_{i},r_{i},s_{i})} \in \mathcal{E}_{t}}\mid{s_{i} = {gap}} \right\}}.$      |     |     |

They form a disjoint partition of the evidence bundle:

|     |                                                                                                                                                  |     |     |
|-----|--------------------------------------------------------------------------------------------------------------------------------------------------|-----|-----|
|     | $${{\mathcal{E}_{t} = {\mathcal{E}_{t}^{ver} \cup \mathcal{E}_{t}^{gap}}},{{\mathcal{E}_{t}^{ver} \cap \mathcal{E}_{t}^{gap}} = \varnothing}}.$$ |     | (6) |

The implementation retains both a human-readable tester report and structured records for subsequent planning. Listing [1](#listing1 "Listing 1 ‣ A.4 Evidence Collection and Representation ‣ Appendix A Method and Implementation Details ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") shows a normalized excerpt organized according to the verified- and gap-record subsets above. Each record preserves the claim, the public execution records used to assess it, and the resulting status. The final block shows how these records are converted into planning inputs for the next iteration.

[⬇](data:text/plain;base64,ewogICJpdGVyYXRpb24iOiAyLAogICJxYV9zdGF0dXMiOiAicGFydGlhbCIsCiAgInZlcmlmaWVkX3JlY29yZHMiOiBbCiAgICB7CiAgICAgICJjbGFpbV9pZCI6ICJwbGF5ZXJfY29udHJvbCIsCiAgICAgICJjbGFpbSI6ICJQbGF5ZXIgaW5wdXQgY2hhbmdlcyBhdmF0YXIgbW90aW9uLiIsCiAgICAgICJleGVjdXRpb25fcmVjb3JkcyI6IFsKICAgICAgICB7CiAgICAgICAgICAidHlwZSI6ICJyZXBsYXkiLAogICAgICAgICAgInBhdGgiOiAicmVwbGF5cy9jb3JlX2xvb3AuanNvbiIsCiAgICAgICAgICAib2JzZXJ2YXRpb24iOiAiTGVmdCBhbmQgcmlnaHQgaW5wdXRzIG1vdmUgdGhlIGF2YXRhci4iCiAgICAgICAgfSwKICAgICAgICB7CiAgICAgICAgICAidHlwZSI6ICJydW50aW1lX3RyYWNlIiwKICAgICAgICAgICJwYXRoIjogInRyYWNlcy9jb3JlX2xvb3AuanNvbiIsCiAgICAgICAgICAib2JzZXJ2YXRpb24iOiAiUG9zaXRpb24gY2hhbmdlcyBhZnRlciBlYWNoIGlucHV0IGV2ZW50LiIKICAgICAgICB9CiAgICAgIF0sCiAgICAgICJzdGF0dXMiOiAidmVyaWZpZWQiCiAgICB9CiAgXSwKICAiZ2FwX3JlY29yZHMiOiBbCiAgICB7CiAgICAgICJjbGFpbV9pZCI6ICJyZXN1bHRfc3RhdGUiLAogICAgICAiY2xhaW0iOiAiQ29tcGxldGluZyB0aGUgb2JqZWN0aXZlIHByb2R1Y2VzIGEgdmlzaWJsZSByZXN1bHQuIiwKICAgICAgImV4ZWN1dGlvbl9yZWNvcmRzIjogWwogICAgICAgIHsKICAgICAgICAgICJ0eXBlIjogInNjcmVlbnNob3QiLAogICAgICAgICAgInBhdGgiOiAic2NyZWVuc2hvdHMvZnJhbWVfMDE4LnBuZyIsCiAgICAgICAgICAib2JzZXJ2YXRpb24iOiAiVGhlIG9iamVjdGl2ZSBlbmRzIHdpdGhvdXQgYSByZXN1bHQgc2NyZWVuLiIKICAgICAgICB9CiAgICAgIF0sCiAgICAgICJzdGF0dXMiOiAiZ2FwIiwKICAgICAgInBsYXllcl9pbXBhY3QiOiAiQ29tcGxldGlvbiBpcyBub3QgdmlzaWJsZSB0byB0aGUgcGxheWVyLiIsCiAgICAgICJyZWNvbW1lbmRlZF91cGRhdGUiOiAiQWRkIGFuZCByZXBsYXkgYSByZXN1bHQgc3RhdGUuIgogICAgfQogIF0sCiAgInBsYW5uZXJfaGFuZG9mZiI6IHsKICAgICJwcmVzZXJ2YXRpb25fY29uc3RyYWludHMiOiBbCiAgICAgICJQcmVzZXJ2ZSB2ZXJpZmllZCBwbGF5ZXIgbW92ZW1lbnQuIgogICAgXSwKICAgICJ1cGRhdGVfdGFyZ2V0cyI6IFsKICAgICAgIkltcGxlbWVudCBhIHZpc2libGUgY29tcGxldGlvbiBzdGF0ZS4iCiAgICBdLAogICAgInZhbGlkYXRpb25fcmVxdWlyZW1lbnRzIjogWwogICAgICAiUmVwbGF5IG9iamVjdGl2ZSBjb21wbGV0aW9uIHRocm91Z2ggdGhlIHJlc3VsdCBzY3JlZW4uIgogICAgXQogIH0KfQ==)

1 {

2 "iteration": 2,

3 "qa_status": "partial",

4 "verified_records": \[

5 {

6 "claim_id": "player_control",

7 "claim": "Player input changes avatar motion.",

8 "execution_records": \[

9 {

10 "type": "replay",

11 "path": "replays/core_loop.json",

12 "observation": "Left and right inputs move the avatar."

13 },

14 {

15 "type": "runtime_trace",

16 "path": "traces/core_loop.json",

17 "observation": "Position changes after each input event."

18 }

19 \],

20 "status": "verified"

21 }

22 \],

23 "gap_records": \[

24 {

25 "claim_id": "result_state",

26 "claim": "Completing the objective produces a visible result.",

27 "execution_records": \[

28 {

29 "type": "screenshot",

30 "path": "screenshots/frame_018.png",

31 "observation": "The objective ends without a result screen."

32 }

33 \],

34 "status": "gap",

35 "player_impact": "Completion is not visible to the player.",

36 "recommended_update": "Add and replay a result state."

37 }

38 \],

39 "planner_handoff": {

40 "preservation_constraints": \[

41 "Preserve verified player movement."

42 \],

43 "update_targets": \[

44 "Implement a visible completion state."

45 \],

46 "validation_requirements": \[

47 "Replay objective completion through the result screen."

48 \]

49 }

50 }

Listing 1 Normalized structured evidence report. Each claim is linked to its public execution records and QA status. Verified records yield preservation constraints, whereas gap records yield update targets and follow-up validation requirements for the next iteration.

For GameCraft-Bench, the evidence bundle is materialized through a screenshot manifest, playtest report, structured status record, replay traces, and tester logs. FrontierSWE uses the same claim–evidence abstraction with the public execution and task-specific test records available in its repository environment.

### A.5 Cross-Iteration State Transfer and Evaluation Isolation

The implementation preserves the two state channels defined in the main paper. The artifact channel carries the updated project $A_{t}$ into the next Developer invocation, while the evidence channel carries $\mathcal{E}_{t}$ into the next Planner invocation. Within iteration $t$, $D_{t}$ is the shared specification for coding and testing; the next Planner constructs a new document from $\mathcal{S}$ and $\mathcal{E}_{t}$ rather than treating $D_{t}$ as a third persistent state channel.

The implementation retains the development document, harness command, process logs, public media manifest, structured QA report, and resulting project workspace for each iteration. These records make the transition from $A_{t - 1}$ to $A_{t}$ and the construction of $\mathcal{E}_{t}$ auditable without exposing evaluator-only information.

Benchmark evaluation is separated from development. Hidden tests, benchmark scores, private rubrics, evaluation formulas, and evaluator rationales are not included in the role prompts or evidence bundle and are never returned to a subsequent iteration. HoH therefore adapts to observable execution and QA findings while the public task specification remains the authoritative requirement source.

## Appendix B Experimental Protocol

### B.1 Harness and Model Configurations

Table [6](#A2.T6 "Table 6 ‣ B.1 Harness and Model Configurations ‣ Appendix B Experimental Protocol ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") lists the three configurations used throughout the main experiments. Harness versions, models, and exposed reasoning settings are held fixed between Vanilla and HoH within each configuration. The main HoH results use $T = 3$.

| Harness                                                                                                 | Version | Model           | Reasoning setting |
|---------------------------------------------------------------------------------------------------------|---------|-----------------|-------------------|
| Codex CLI¹¹ 1 Equal contribution. {yanhaoyang, suminle, zhanghangfan, lizhanhao, hushuyue}@pjlab.org.cn | 0.142.5 | GPT-5.5         | High              |
| OpenCode²² 2 [https://github.com/anomalyco/opencode](https://github.com/anomalyco/opencode)             | 1.14.30 | DeepSeek-V4-Pro | —                 |
| Pi Coding Agent³³ 3 [https://github.com/earendil-works/pi](https://github.com/earendil-works/pi)        | 0.80.10 | MiniMax-M3      | Client-side high  |

Table 6: Harness–model configurations used in the experiments.

¹¹footnotetext: [https://github.com/openai/codex](https://github.com/openai/codex)

### B.2 Run Configuration and Repetition

The main experiments use three HoH iterations. Vanilla performs one standard development pass, and the budget-controlled experiment additionally evaluates two and three sequential Vanilla development passes. HoH reports the artifact produced after the prescribed iteration budget; intermediate artifacts are evaluated only for analysis and are not selected using benchmark scores. Evaluator outputs are not returned to the planning, coding, or testing stages.

Table [7](#A2.T7 "Table 7 ‣ B.2 Run Configuration and Repetition ‣ Appendix B Experimental Protocol ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") summarizes the run structure used for each experiment. Every reported task–condition score is obtained from one valid run. When an attempt fails because of an infrastructure or model-provider transport error, the failed attempt is replaced rather than included as an additional replicate. Aggregate scores therefore average over tasks, not over multiple generations of the same task–condition pair.

|  Experiment         |  Benchmark                        |  Development structure                                                 |  Runs per task–condition  |
|---------------------|-----------------------------------|------------------------------------------------------------------------|---------------------------|
|  Main comparison    |  GameCraft-Bench and FrontierSWE  |  Vanilla: one coding pass; HoH: $T = 3$ iterations                     |  1                        |
|  Budget comparison  |  GameCraft-Bench                  |  Vanilla Continuation: one, two, or three coding passes; HoH: $T = 3$  |  1                        |
|  Ablation study     |  GameCraft-Bench                  |  Full HoH and each ablation: $T = 3$                                   |  1                        |

Table 7: Run configurations used in the reported experiments.

Task–condition runs start from separate copies of the benchmark-provided workspace. Within a harness–model configuration, Vanilla and HoH use the same model, native harness settings, public task materials, and benchmark tools. The selected clients do not expose a common reproducible generation seed, and we do not override temperature or top-$p$; the corresponding client and provider defaults are used throughout. The fixed seeds reported below control task sampling and statistical resampling rather than model generation.

### B.3 Computing Environments

The two benchmarks use different execution environments because they exercise different software artifacts. Table [8](#A2.T8 "Table 8 ‣ B.3 Computing Environments ‣ Appendix B Experimental Protocol ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") records the shared runtime components. Model inference is provided through the remote services associated with the configurations in Table [6](#A2.T6 "Table 6 ‣ B.1 Harness and Model Configurations ‣ Appendix B Experimental Protocol ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"); the listed machines execute the harnesses, generated artifacts, and benchmark verifiers.

|  Component         |  GameCraft-Bench                                          |  FrontierSWE                                                           |
|--------------------|-----------------------------------------------------------|------------------------------------------------------------------------|
|  Isolation         |  Run-local workspace in a local-subprocess environment    |  Official task container launched through a run-local Docker daemon    |
|  Host              |  Ubuntu 24.04.3; Intel Core i7-14700; 64 GB RAM           |  Linux compute workers; NVIDIA H200 for tasks requiring a GPU          |
|  Runtime           |  Python 3.12.3; Godot 4.6.2; Xvfb-backed display capture  |  Docker with the official task-specific software image                 |
|  Resource control  |  No task-specific GPU allocation                          |  CPU, memory, storage, and GPU limits specified by each official task  |

Table 8: Computing environments used for artifact development and evaluation. FrontierSWE task images retain their benchmark-defined dependencies and resource declarations.

FrontierSWE uses a Docker-in-Docker execution design. An outer execution container starts a run-local Docker daemon, which launches the official task-specific image. The inner container receives the CPU, memory, storage, and accelerator limits declared by that task. GPU passthrough is enabled only for tasks that request an accelerator. This preserves the task software stack and prevents dependencies from one task from affecting another.

### B.4 Benchmark Sampling and Evaluated Tasks

Table [9](#A2.T9 "Table 9 ‣ B.4 Benchmark Sampling and Evaluated Tasks ‣ Appendix B Experimental Protocol ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") summarizes the benchmark subsets used in the main experiments. GameCraft-Bench \[[23](#bib.bib1)\] is sampled by its 15 public game families and is additionally organized into five coarse reporting groups for analysis. FrontierSWE \[[6](#bib.bib5)\] uses the benchmark’s three official categories.

| Benchmark       | Tasks |  Fine categories  |  Reporting groups  |  Tasks per category  |
|-----------------|-------|-------------------|--------------------|----------------------|
| GameCraft-Bench | 45    | 15                | 5                  | 3 per family         |
| FrontierSWE     | 15    | 3                 | 3                  | 4 / 9 / 2            |

Table 9: Composition of the evaluated benchmark subsets. Counts refer to the tasks used for every harness–model configuration in the main experiments.

#### B.4.1 GameCraft-Bench

We use a fixed 45-task subset with three tasks from each of the benchmark’s 15 public game families. The subset was constructed incrementally from a fixed earlier subset and completed to three tasks per family by seeded stratified sampling (seed 20260707), without reference to model scores.

For compact reporting, we group the 15 families into five coarse categories, each containing three families and nine tasks: Action contains Platformer, Shooter, and Roguelike; Timing contains Racing, Rhythm, and Sports; Strategy contains Strategy, Card Game, and Puzzle; Simulation contains Tycoon, Idle, and Simulation; and Adventure contains Horror, Open World, and Visual Novel. These five groups are introduced only for aggregate analysis; all task scores continue to use the benchmark’s original family definitions.

|  Family        |  Task              |  Benchmark identifier           |
|----------------|--------------------|---------------------------------|
| Action         |                    |                                 |
|  Platformer    |  Momentum Lab      |  platformer-momentum-lab        |
|                |  Ivory Beats       |  platformer-ivory-beats         |
|                |  Thunder Valkyrie  |  platformer-thunder-valkyrie    |
|  Shooter       |  Void Patrol       |  shooter-void-patrol            |
|                |  Wave Commander    |  shooter-wave-commander         |
|                |  Hotline Heist     |  shooter-hotline-heist          |
|  Roguelike     |  Dungeon Shop      |  roguelike-dungeon-shop         |
|                |  Breach Tactics    |  roguelike-breach-tactics       |
|                |  Void Harvest      |  roguelike-action-void-harvest  |
| Timing         |                    |                                 |
|  Racing        |  Drift Circuit     |  racing-drift-circuit           |
|                |  Rocket Trials     |  racing-rocket-trials           |
|                |  Trick Runner      |  racing-trick-runner            |
|  Rhythm        |  Note Highway      |  rhythm-note-highway            |
|                |  Beat Dungeon      |  rhythm-beat-dungeon            |
|                |  Garden            |  rhythm-garden                  |
|  Sports        |  Skateboard Park   |  sports-skateboard-park         |
|                |  Boxing Gym        |  sports-boxing-gym              |
|                |  Archery Quest     |  sports-archery-quest           |
| Strategy       |                    |                                 |
|  Strategy      |  Tower Defense     |  strategy-towerdefense          |
|                |  Chess Variant     |  strategy-chess-variant         |
|                |  Spell Tactics     |  strategy-spell-tactics         |
|  Card Game     |  Spire Descent     |  cardgame-spire-descent         |
|                |  Poker Roguelike   |  cardgame-poker-roguelike       |
|                |  Autobattler       |  cardgame-autobattler           |
|  Puzzle        |  Sokoban Dungeon   |  puzzle-sokoban-dungeon         |
|                |  Circuit Wizard    |  puzzle-circuit-wizard          |
|                |  Pipe Crisis       |  puzzle-pipe-crisis             |
| Simulation     |                    |                                 |
|  Tycoon        |  Space Colony      |  tycoon-space-colony            |
|                |  Pirate Port       |  tycoon-pirate-port             |
|                |  Wildhaven         |  tycoon-wildhaven               |
|  Idle          |  Ant Empire        |  idle-ant-empire                |
|                |  Factory Planet    |  idle-factory-planet            |
|                |  Dungeon Guild     |  idle-dungeon-guild             |
|  Simulation    |  Kitchen Rush      |  simulation-kitchen-rush        |
|                |  Air Control       |  simulation-air-control         |
|                |  Border Check      |  simulation-border-check        |
| Adventure      |                    |                                 |
|  Horror        |  Floor 13          |  horror-floor-13                |
|                |  Dollhouse         |  horror-dollhouse               |
|                |  Lighthouse        |  horror-lighthouse              |
|  Open World    |  Sky Islands       |  openworld-sky-islands          |
|                |  Airship Trader    |  openworld-airship-trader       |
|                |  Bounty            |  openworld-bounty               |
|  Visual Novel  |  Detective Noir    |  visualnovel-detective-noir     |
|                |  Arcane Academy    |  visualnovel-arcaneacademy      |
|                |  Time Paradox      |  visualnovel-time-paradox       |

Table 10: GameCraft-Bench reporting groups, benchmark families, and sampled tasks. Each family contributes three tasks.

#### B.4.2 FrontierSWE

We evaluate 15 FrontierSWE tasks under the benchmark’s official taxonomy: four Implementation tasks, nine Performance tasks, and two Research tasks. We additionally distinguish tasks that construct an independent deliverable from a scaffold or task specification from those that optimize an existing system. Under this criterion, 10 tasks are labeled end-to-end and five are labeled optimization.

|  Task                                   |  Scope         |  Brief task description                                                                                                                                              |
|-----------------------------------------|----------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Implementation                          |                |                                                                                                                                                                      |
|  Dart Style Haskell                     |  End-to-end    |  Reimplement the Dart formatter in Haskell as a Cabal-built executable compatible with the relevant CLI behavior and golden formatting cases.                        |
|  Git to Zig                             |  End-to-end    |  Reimplement Git 2.47 as a Zig binary compatible with Git’s CLI, output, and exit-code behavior, without reusing the existing Git implementation or network access.  |
|  Lua Native Compiler                    |  End-to-end    |  Compile Lua 5.4 bytecode to a standalone native x86-64 executable with reference-equivalent output, rather than an interpreter or API wrapper.                      |
|  PostgreSQL–SQLite Wire Adapter         |  End-to-end    |  Build a Zig server backed by SQLite that emulates the required PostgreSQL server, wire-protocol, lifecycle, and CLI behavior.                                       |
| Performance                             |                |                                                                                                                                                                      |
|  Cranelift Codegen Optimization         |  Optimization  |  Optimize compiled WebAssembly runtime performance in Wasmtime’s Cranelift backend, subject to correctness gates and weighted speedup scoring.                       |
|  Dependent Type Checker                 |  End-to-end    |  Implement a correct, high-throughput Martin-Löf type checker in Rust; correctness thresholds must be met before throughput is scored.                               |
|  FFmpeg Swscale Rewrite                 |  End-to-end    |  Rewrite libswscale in Zig or Rust behind its required C ABI, with image-quality gates before geometric-mean speedup scoring.                                        |
|  Granite Mamba2 Inference Optimization  |  Optimization  |  Optimize a standalone Granite Mamba2 layer while preserving CUDA bfloat16 outputs and cache behavior across the evaluated workloads.                                |
|  Inference System Optimization          |  Optimization  |  Accelerate a Qwen-based SGLang serving system while preserving token-level output equivalence under latency and throughput workloads.                               |
|  Libexpat to x86 Assembly               |  End-to-end    |  Reimplement the required libexpat API as an independent x86-64 assembly shared library without delegating to the existing implementation.                           |
|  Notebook Compression                   |  End-to-end    |  Build a lossless domain-specific notebook compressor with fit, compress, and decompress interfaces; exact recovery is required before compression ratio is scored.  |
|  Pyright Type-Checking Optimization     |  Optimization  |  Optimize Pyright’s type-evaluation hot paths while preserving build success, all required tests, and reference-equivalent diagnostics.                              |
|  Revideo Performance Optimization       |  Optimization  |  Optimize Revideo’s programmatic rendering pipeline without frame skipping, quality reduction, resolution changes, or visible-output deviations.                     |
| Research                                |                |                                                                                                                                                                      |
|  Optimizer Design                       |  End-to-end    |  Implement one torch.optim.Optimizer and a shared hyperparameter configuration that generalizes across heterogeneous ML workloads.                                   |
|  PCQM4Mv2 Autoresearch                  |  End-to-end    |  Train a 2D molecular-graph regressor under data, model, and parameter constraints to minimize the evaluated molecular-property error.                               |

Table 11: FrontierSWE tasks grouped by official category and construction scope.

Two official FrontierSWE tasks are not included in the evaluated subset. Their omission is determined by execution requirements rather than model outcomes.

|  Task                 |  Reason                                                                                                                                               |
|-----------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
|  frogsgame-rl         |  Requires authenticated access to the external Tinker API, which was unavailable in the evaluation environment.                                       |
|  modular-stack-wan21  |  Requires a Modular MAX software stack needing an NVIDIA driver of at least 580 (CUDA 13), whereas the available H200 worker used driver 570.133.20.  |

Table 12: FrontierSWE tasks excluded from the evaluated subset.

### B.5 Baseline and Budget-Controlled Protocols

##### Vanilla.

Vanilla uses the corresponding harness–model configuration without the HoH protocol and performs one standard development pass from the benchmark-provided initial artifact.

##### Vanilla Continuation.

The budget-controlled comparison extends the selected Vanilla artifact through two additional invocations of the same harness–model configuration. Let $A_{1}^{VC}$ denote the artifact produced by the standard Vanilla pass. For $k \in {\{{2,3}\}}$, Vanilla Continuation applies

|     |                                                                                               |     |     |
|-----|-----------------------------------------------------------------------------------------------|-----|-----|
|     | $${A_{k}^{VC} = {{Dev}_{H}\hspace{0pt}\left( A_{k - 1}^{VC},\mathcal{S},p_{cont} \right)}},$$ |     | (7) |

where $p_{cont}$ is the fixed instruction shown below. Thus, each additional pass starts from the latest artifact, but receives neither a development document nor evidence from a separate QA Tester invocation.

![](data:image/svg+xml;base64,PHN2ZyBjbGFzcz0ibHR4X3BpY3R1cmUiIGhlaWdodD0iNTguNjMiIGlkPSJBMi5TUzUuU1NTMC5QeDIucDIucGljMSIgb3ZlcmZsb3c9InZpc2libGUiIHZlcnNpb249IjEuMSIgdmlld2JveD0iMCAwIDY1My4xNSA1OC42MyIgd2lkdGg9IjY1My4xNSI+PGcgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBzdHJva2Utd2lkdGg9IjAuNHB0IiBzdHlsZT0iLS1sdHgtc3Ryb2tlLWNvbG9yOiMwMDAwMDA7LS1sdHgtZmlsbC1jb2xvcjojMDAwMDAwOyIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCw1OC42MykgbWF0cml4KDEgMCAwIC0xIDAgMCkiPjxnIGZpbGw9IiMwMDAwMDAiIGZpbGwtb3BhY2l0eT0iMS4wIiBzdHlsZT0iLS1sdHgtZmlsbC1jb2xvcjojMDAwMDAwOyI+PHBhdGggZD0iTSAwIDMuNzQgTCAwIDU0Ljg5IEMgMCA1Ni45NSAxLjY3IDU4LjYzIDMuNzQgNTguNjMgTCA2NDkuNDEgNTguNjMgQyA2NTEuNDggNTguNjMgNjUzLjE1IDU2Ljk1IDY1My4xNSA1NC44OSBMIDY1My4xNSAzLjc0IEMgNjUzLjE1IDEuNjcgNjUxLjQ4IDAgNjQ5LjQxIDAgTCAzLjc0IDAgQyAxLjY3IDAgMCAxLjY3IDAgMy43NCBaIiBzdHlsZT0ic3Ryb2tlOm5vbmUiIC8+PC9nPjxnIGZpbGw9IiNGMkYyRjIiIGZpbGwtb3BhY2l0eT0iMS4wIiBzdHlsZT0iLS1sdHgtZmlsbC1jb2xvcjojRjJGMkYyOyI+PHBhdGggZD0iTSAwLjk3IDMuNzQgTCAwLjk3IDM2LjUyIEwgNjUyLjE4IDM2LjUyIEwgNjUyLjE4IDMuNzQgQyA2NTIuMTggMi4yMSA2NTAuOTQgMC45NyA2NDkuNDEgMC45NyBMIDMuNzQgMC45NyBDIDIuMjEgMC45NyAwLjk3IDIuMjEgMC45NyAzLjc0IFoiIHN0eWxlPSJzdHJva2U6bm9uZSIgLz48L2c+PGcgZmlsbC1vcGFjaXR5PSIxLjAiIHRyYW5zZm9ybT0ibWF0cml4KDEuMCAwLjAgMC4wIDEuMCAxNC41OSA0NC4xMSkiPjxmb3JlaWdub2JqZWN0IGhlaWdodD0iMTIuMyIgb3ZlcmZsb3c9InZpc2libGUiIHN0eWxlPSItLWx0eC1mby13aWR0aDo0MC45OWVtOy0tbHR4LWZvLWhlaWdodDowLjY5ZW07LS1sdHgtZm8tZGVwdGg6MC4xOWVtO2ZvbnQtc2l6ZToxMHB0OyIgdHJhbnNmb3JtPSJtYXRyaXgoMSAwIDAgLTEgMCA5LjYxKSIgd2lkdGg9IjU2Ny4xOSI+PHNwYW4gY2xhc3M9Imx0eF9mb3JlaWdub2JqZWN0X2NvbnRhaW5lciI+PHNwYW4gY2xhc3M9Imx0eF9mb3JlaWdub2JqZWN0X2NvbnRlbnQiPgo8c3BhbiBjbGFzcz0ibHR4X2lubGluZS1ibG9jayBsdHhfbWluaXBhZ2UgbHR4X2FsaWduX2JvdHRvbSIgaWQ9IkEyLlNTNS5TU1MwLlB4Mi5wMi5waWMxLjEiIHN0eWxlPSJ3aWR0aDo0MC45OWVtOyI+CjxzcGFuIGNsYXNzPSJsdHhfcCIgaWQ9IkEyLlNTNS5TU1MwLlB4Mi5wMi5waWMxLjEuMSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IGx0eF9mb250X3NhbnNzZXJpZiBsdHhfZm9udF9ib2xkIiBpZD0iQTIuU1M1LlNTUzAuUHgyLnAyLnBpYzEuMS4xLjEiIHN0eWxlPSItLWx0eC1mZy1jb2xvcjojRkZGRkZGOyI+VmFuaWxsYSBDb250aW51YXRpb24gUHJvbXB0PC9zcGFuPjwvc3Bhbj4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+PC9mb3JlaWdub2JqZWN0PjwvZz48ZyBmaWxsLW9wYWNpdHk9IjEuMCIgdHJhbnNmb3JtPSJtYXRyaXgoMS4wIDAuMCAwLjAgMS4wIDE0LjU5IDE1LjYzKSI+PGZvcmVpZ25vYmplY3QgaGVpZ2h0PSIxMS4wNyIgb3ZlcmZsb3c9InZpc2libGUiIHN0eWxlPSItLWx0eC1mby13aWR0aDo0OC43NWVtOy0tbHR4LWZvLWhlaWdodDowLjYzZW07LS1sdHgtZm8tZGVwdGg6MC4xOGVtO2ZvbnQtc2l6ZToxMHB0OyIgdHJhbnNmb3JtPSJtYXRyaXgoMSAwIDAgLTEgMCA4LjY1KSIgd2lkdGg9IjY3NC41NiI+PHNwYW4gY2xhc3M9Imx0eF9mb3JlaWdub2JqZWN0X2NvbnRhaW5lciI+PHNwYW4gY2xhc3M9Imx0eF9mb3JlaWdub2JqZWN0X2NvbnRlbnQiPgo8c3BhbiBjbGFzcz0ibHR4X2lubGluZS1ibG9jayBsdHhfbWluaXBhZ2UgbHR4X2FsaWduX2JvdHRvbSIgaWQ9IkEyLlNTNS5TU1MwLlB4Mi5wMi5waWMxLjIiIHN0eWxlPSJ3aWR0aDo0OC43NWVtOyI+CjxzcGFuIGNsYXNzPSJsdHhfcCIgaWQ9IkEyLlNTNS5TU1MwLlB4Mi5wMi5waWMxLjIuMSI+PHNwYW4gY2xhc3M9Imx0eF90ZXh0IiBpZD0iQTIuU1M1LlNTUzAuUHgyLnAyLnBpYzEuMi4xLjEiIHN0eWxlPSJmb250LXNpemU6OTAlOy0tbHR4LWZnLWNvbG9yOiMwMDAwMDA7Ij5Db250aW51ZSBkZXZlbG9waW5nIGFuZCB0ZXN0aW5nIHRoZSBjdXJyZW50IGdhbWUuPC9zcGFuPjwvc3Bhbj4KPC9zcGFuPjwvc3Bhbj48L3NwYW4+PC9mb3JlaWdub2JqZWN0PjwvZz48L2c+PC9zdmc+)

The comparison therefore holds the initial task set and harness–model configuration fixed while separating repeated coding passes from the planning–coding–testing structure of HoH.

### B.6 Ablation Protocols

The ablations retain the three-iteration budget and the same harness–model configuration as full HoH. Relative to the full iteration in Eq. [3](#A1.E3 "Equation 3 ‣ A.1 HoH Execution Protocol ‣ Appendix A Method and Implementation Details ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), each variant changes one cross-iteration input while leaving the remaining interfaces unchanged:

|     |            |                                                                            |     |     |
|-----|------------|----------------------------------------------------------------------------|-----|-----|
|     | $\text{:}$ | $D{}_{t} = D{}_{1},t > 1,$                                                 |     | (8) |
|     | $\text{:}$ | ${D_{t} = {{Plan}_{H}\hspace{0pt}(\mathcal{S},\varnothing)}},$             |     |     |
|     | $\text{:}$ | ${A_{t} = {{Dev}_{H}\hspace{0pt}\left( A_{0},\mathcal{S},D_{t} \right)}}.$ |     |     |

In *w/o Plan Update*, the first development document is reused in all later iterations, although coding and testing continue on the evolving artifact. In *w/o Evidence Feedback*, the QA Tester still evaluates each updated artifact, but its evidence is withheld from the next Planner invocation. In *w/o Warm-Start*, evidence-conditioned planning and QA testing remain active, while every Developer invocation begins from the benchmark-provided initial artifact $A_{0}$.

|  Variant                |  Development document             |  Coding start  |  Evidence for next plan  |
|-------------------------|-----------------------------------|----------------|--------------------------|
|  Full HoH               |  Updated from preceding evidence  |  $A_{t - 1}$   |  $\mathcal{E}_{t - 1}$   |
|  w/o Plan Update        |  Fixed to $D_{1}$                 |  $A_{t - 1}$   |  Not consumed            |
|  w/o Evidence Feedback  |  Updated from $\mathcal{S}$ only  |  $A_{t - 1}$   |  Withheld                |
|  w/o Warm-Start         |  Updated from preceding evidence  |  $A_{0}$       |  $\mathcal{E}_{t - 1}$   |

Table 13: Information channels retained by the ablation variants.

### B.7 Metrics and Resource Accounting

##### GameCraft-Bench dimensions.

GameCraft-Bench evaluates runnable game artifacts along four dimensions. *Core Mechanics* measures implementation of the required gameplay mechanics and interaction loop. *Content Depth* measures the breadth and variety of stages, challenges, objectives, and progression. *Functional Visuals* measures the visibility, readability, and feedback of gameplay states. *Art and Presentation* measures visual coherence, asset quality, interface styling, and polish. Let $M$, $D$, $V$, and $A$ denote the mean rubric-item scores for these four dimensions, respectively.

##### GameCraft-Bench Overall.

The benchmark combines the four dimensions as

|     |                                                                                                                                                         |     |     |
|-----|---------------------------------------------------------------------------------------------------------------------------------------------------------|-----|-----|
|     | $${{Overall} = {100\hspace{0pt}B\hspace{0pt}\left( {{0.15\hspace{0pt}M} + {0.35\hspace{0pt}D} + {0.15\hspace{0pt}V} + {0.35\hspace{0pt}A}} \right)}},$$ |     | (9) |

where $B = 1$ if the game artifact compiles and runs and $B = 0$ otherwise.

##### FrontierSWE reward.

We report the task-specific official reward and its mean over the 15 evaluated tasks.

##### Task-level aggregation.

For a benchmark task set $\mathcal{B}$ and evaluated condition $c$, the reported aggregate is the unweighted mean of its task-level scores:

|     |                                                                                                                                                         |     |      |
|-----|---------------------------------------------------------------------------------------------------------------------------------------------------------|-----|------|
|     | $${{{\overline{s}}_{\mathcal{B}}\hspace{0pt}{(c)}} = {\frac{1}{|\mathcal{B}|}\hspace{0pt}{\sum\limits_{i \in \mathcal{B}}{s_{i}\hspace{0pt}{(c)}}}}}.$$ |     | (10) |

For GameCraft-Bench, $s_{i}$ is the 0–100 Overall score and ${|\mathcal{B}|} = 45$; for FrontierSWE, $s_{i}$ is the official reward and ${|\mathcal{B}|} = 15$.

##### Bootstrap uncertainty.

The 95% confidence intervals for the GameCraft-Bench component analysis in the main paper are percentile intervals from 20,000 task-bootstrap resamples. Tasks are sampled with replacement, all four component scores for a sampled task are retained together, and means are recomputed for every resample. The bootstrap uses seed 20260729.

##### Model-interaction volume.

Token counts include the provider-reported input and output tokens from coding-harness model calls and exclude benchmark evaluation. Input totals may include cached context reads, whose accounting differs across providers. Let $\mathcal{I}_{i}\hspace{0pt}{(c)}$ denote the model calls made for task $i$ under condition $c$. Cumulative token use, in millions of tokens, is

|     |                                                                                                                                                                                                                                                                                                |     |      |
|-----|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----|------|
|     | $${{{C_{i}\hspace{0pt}{(c)}} = {10^{- 6}\hspace{0pt}{\sum\limits_{j \in {\mathcal{I}_{i}\hspace{0pt}{(c)}}}\left( {n_{j}^{in} + n_{j}^{out}} \right)}}},{{\overline{C}\hspace{0pt}{(c)}} = {\frac{1}{|\mathcal{B}|}\hspace{0pt}{\sum\limits_{i \in \mathcal{B}}{C_{i}\hspace{0pt}{(c)}}}}}}.$$ |     | (11) |

We compare token usage within each harness–model configuration because cache accounting differs across providers. In the budget-controlled comparison, we also report the quality gained per additional million tokens relative to Vanilla:

|     |                                                                                                                                                                                                |     |      |
|-----|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----|------|
|     | $${{\eta{(c)}} = \frac{{{\overline{s}}_{GC}\hspace{0pt}{(c)}} - {{\overline{s}}_{GC}\hspace{0pt}{({Vanilla})}}}{{\overline{C}\hspace{0pt}{(c)}} - {\overline{C}\hspace{0pt}{({Vanilla})}}}}.$$ |     | (12) |

##### Official dominance.

We apply the official dominance procedure to the final 15-task subset. Within each domain, the comparison pool contains all ${3 \times 4} = 12$ system–condition configurations: the three systems under Vanilla, HoH@1, HoH@2, and HoH@3. For a configuration $a$, let $d$ denote a domain, let $t$ denote a task in that domain, and let $r_{a,t}$ denote $a$’s official reward on $t$.

All pairwise comparisons occur on the same task. For any opponent $j$ among the other 11 configurations, the comparison score is

|     |                              |     |      |
|-----|------------------------------|-----|------|
|     | $${s{(x,y)}} = \begin{cases} 
       {1,} & {{x > y},} \\          
       {0.5,} & {{x = y},} \\        
       {0,} & {{x < y}.}             
       \end{cases}$$                 |     | (13) |

The task-level dominance of $a$ is therefore

|     |                                                                                                            |     |      |
|-----|------------------------------------------------------------------------------------------------------------|-----|------|
|     | $${{{Dominance}_{d,t}{(a)}} = {\frac{1}{11}\hspace{0pt}{\sum\limits_{j \neq a}{s{(r_{a,t},r_{j,t})}}}}}.$$ |     | (14) |

Equivalently, this quantity is the expected comparison score when the opponent is selected uniformly from the other 11 configurations. The implementation computes this expectation exactly by averaging over all 11 opponents. The denominator is 11 because $a$ is compared with every other member of the 12-configuration pool, but not with itself. Domain-level dominance averages these values equally over the $N_{d}$ tasks in domain $d$:

|     |                                                                                                                                                                                               |     |      |
|-----|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----|------|
|     | $${{{Dominance}_{d}{(a)}} = {\frac{1}{N_{d}}\hspace{0pt}{\sum\limits_{t = 1}^{N_{d}}\left\lbrack {\frac{1}{11}\hspace{0pt}{\sum\limits_{j \neq a}{s{(r_{a,t},r_{j,t})}}}} \right\rbrack}}}.$$ |     | (15) |

Here, $N_{d}$ is 4, 9, and 2 for Implementation, Performance, and Research, respectively. The reported FrontierSWE dominance is the macro average over the three domains:

|     |                                                                                              |     |      |
|-----|----------------------------------------------------------------------------------------------|-----|------|
|     | $${{{Dominance}{(a)}} = {\frac{1}{3}\hspace{0pt}{\sum\limits_{d}{{Dominance}_{d}{(a)}}}}}.$$ |     | (16) |

In this expression, $d$ ranges over Implementation, Performance, and Research, and each domain receives equal weight.

### B.8 Player-Experience Evaluation and PXI Aggregation

The source-blinded Fusepoint playtest uses the full Player Experience Inventory (PXI) \[[34](#bib.bib42)\]. The validated core comprises ten constructs, each measured by three items on the official seven-point scale from $- 3$ to $+ 3$. For evaluator $p$, construct $k$, and its three item responses $x_{p,k,j}$, we compute

|     |                                                                              |     |      |
|-----|------------------------------------------------------------------------------|-----|------|
|     | $${s_{p,k} = {\frac{1}{3}\hspace{0pt}{\sum\limits_{j = 1}^{3}x_{p,k,j}}}}.$$ |     | (17) |

The official questionnaire’s separate three-item Enjoyment outcome is scored in the same way but is not treated as an eleventh core PXI construct. For each reported outcome, the main-paper table gives the mean and sample standard deviation of $s_{p,k}$ across evaluators; individual ratings and comments are retained for auditability.

We do not compute a global PXI total. A review conducted during an independent validation found that some prior applications averaged the ten, or sometimes eleven, outcomes into a single general player-experience score. However, the preregistered validation with 1,518 players found better fit for the ten-factor model—or the eleven-factor model when Enjoyment is included—than for models with a general player-experience factor or higher-order consequence factors \[[31](#bib.bib43)\]. We therefore interpret the constructs separately. The main-paper table additionally reports unweighted descriptive averages over the five Functional and five Psychosocial construct scores for compact summary; these averages are not treated as validated higher-order PXI scales. No score combining all ten constructs, sum-score, percentage conversion, or cutoff is reported as a PXI total.

### B.9 Reproducibility Artifacts

The anonymous code package accompanying the submission contains the core HoH implementation, role prompt templates, the GameCraft-Bench adapter, and the necessary wrappers for the evaluated harness–model configurations. Benchmark repositories, task data, raw run artifacts, analysis records, environment files, private credentials, provider secrets, and benchmark-hidden evaluator contents are not included.

## Appendix C Complete Experimental Results

### C.1 GameCraft-Bench Per-Task Scores

Figure [7](#A3.F7 "Figure 7 ‣ C.1 GameCraft-Bench Per-Task Scores ‣ Appendix C Complete Experimental Results ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") summarizes Vanilla and HoH@3 over the five reporting groups before the complete task-level results. Each bar is the unweighted mean of the nine tasks in that group.

Figure 7: GameCraft-Bench Overall scores by reporting group and harness–model configuration. Each group contains nine tasks.

Tables [14](#A3.T14 "Table 14 ‣ C.1 GameCraft-Bench Per-Task Scores ‣ Appendix C Complete Experimental Results ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement")–[16](#A3.T16 "Table 16 ‣ C.1 GameCraft-Bench Per-Task Scores ‣ Appendix C Complete Experimental Results ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") report the four observed conditions for every sampled GameCraft-Bench task. Scores are converted to the benchmark’s 0–100 presentation scale and grouped using the five coarse categories defined in Table [10](#A2.T10 "Table 10 ‣ B.4.1 GameCraft-Bench ‣ B.4 Benchmark Sampling and Evaluated Tasks ‣ Appendix B Experimental Protocol ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"). The final column reports the task-specific change from Vanilla to HoH@3.

|  Family        |  Task              | Vanilla | HoH@1 | HoH@2 | HoH@3 | $\Delta$ |
|----------------|--------------------|---------|-------|-------|-------|----------|
| Action         |                    |         |       |       |       |          |
|  Platformer    |  Momentum Lab      | 34.05   | 64.44 | 56.15 | 70.61 | +36.56   |
|                |  Ivory Beats       | 46.81   | 73.28 | 78.55 | 85.42 | +38.61   |
|                |  Thunder Valkyrie  | 53.51   | 68.24 | 71.82 | 73.67 | +20.15   |
|  Shooter       |  Void Patrol       | 58.59   | 73.90 | 76.02 | 87.83 | +29.23   |
|                |  Wave Commander    | 66.97   | 69.35 | 74.64 | 75.25 | +8.28    |
|                |  Hotline Heist     | 43.37   | 35.71 | 59.17 | 62.81 | +19.44   |
|  Roguelike     |  Dungeon Shop      | 40.89   | 50.55 | 50.15 | 65.09 | +24.20   |
|                |  Breach Tactics    | 53.44   | 55.67 | 57.11 | 61.09 | +7.65    |
|                |  Void Harvest      | 41.05   | 46.39 | 55.43 | 57.43 | +16.38   |
| Timing         |                    |         |       |       |       |          |
|  Racing        |  Drift Circuit     | 43.58   | 58.29 | 60.29 | 70.08 | +26.50   |
|                |  Rocket Trials     | 45.19   | 61.32 | 68.00 | 70.31 | +25.12   |
|                |  Trick Runner      | 51.50   | 36.09 | 54.44 | 64.78 | +13.28   |
|  Rhythm        |  Note Highway      | 39.44   | 31.35 | 56.15 | 64.68 | +25.24   |
|                |  Beat Dungeon      | 47.94   | 56.95 | 60.55 | 60.81 | +12.88   |
|                |  Garden            | 52.75   | 65.33 | 69.01 | 70.69 | +17.94   |
|  Sports        |  Skateboard Park   | 57.64   | 69.51 | 72.62 | 81.14 | +23.49   |
|                |  Boxing Gym        | 43.08   | 40.34 | 45.61 | 73.14 | +30.06   |
|                |  Archery Quest     | 58.09   | 64.96 | 71.56 | 76.69 | +18.60   |
| Strategy       |                    |         |       |       |       |          |
|  Strategy      |  Tower Defense     | 58.85   | 63.98 | 64.12 | 76.92 | +18.07   |
|                |  Chess Variant     | 30.04   | 56.93 | 52.83 | 59.72 | +29.68   |
|                |  Spell Tactics     | 53.10   | 47.39 | 60.70 | 63.32 | +10.22   |
|  Card Game     |  Spire Descent     | 25.85   | 45.47 | 54.81 | 61.92 | +36.07   |
|                |  Poker Roguelike   | 44.66   | 63.94 | 67.99 | 69.27 | +24.61   |
|                |  Autobattler       | 55.06   | 72.39 | 71.28 | 72.22 | +17.16   |
|  Puzzle        |  Sokoban Dungeon   | 55.75   | 58.98 | 58.56 | 70.13 | +14.38   |
|                |  Circuit Wizard    | 31.35   | 38.97 | 40.82 | 49.52 | +18.17   |
|                |  Pipe Crisis       | 41.88   | 65.07 | 68.65 | 72.17 | +30.28   |
| Simulation     |                    |         |       |       |       |          |
|  Tycoon        |  Space Colony      | 36.88   | 64.60 | 69.15 | 76.55 | +39.67   |
|                |  Pirate Port       | 51.32   | 63.06 | 70.75 | 77.81 | +26.48   |
|                |  Wildhaven         | 49.43   | 74.09 | 77.78 | 80.39 | +30.96   |
|  Idle          |  Ant Empire        | 65.52   | 71.42 | 69.64 | 87.88 | +22.36   |
|                |  Factory Planet    | 75.16   | 78.94 | 82.27 | 87.78 | +12.63   |
|                |  Dungeon Guild     | 63.92   | 68.94 | 76.95 | 79.50 | +15.57   |
|  Simulation    |  Kitchen Rush      | 42.62   | 48.07 | 65.64 | 73.38 | +30.75   |
|                |  Air Control       | 54.24   | 63.96 | 66.72 | 69.73 | +15.50   |
|                |  Border Check      | 43.58   | 67.70 | 67.00 | 72.74 | +29.17   |
| Adventure      |                    |         |       |       |       |          |
|  Horror        |  Floor 13          | 48.68   | 70.73 | 68.56 | 73.41 | +24.73   |
|                |  Dollhouse         | 56.33   | 64.28 | 66.93 | 72.59 | +16.27   |
|                |  Lighthouse        | 51.95   | 63.89 | 71.47 | 80.90 | +28.95   |
|  Open World    |  Sky Islands       | 53.25   | 47.19 | 60.91 | 68.25 | +15.00   |
|                |  Airship Trader    | 59.58   | 73.60 | 74.40 | 74.41 | +14.83   |
|                |  Bounty            | 47.00   | 67.47 | 63.31 | 68.27 | +21.27   |
|  Visual Novel  |  Detective Noir    | 47.46   | 63.15 | 55.54 | 65.31 | +17.85   |
|                |  Arcane Academy    | 59.30   | 37.60 | 62.71 | 70.69 | +11.39   |
|                |  Time Paradox      | 50.63   | 63.28 | 71.15 | 71.97 | +21.34   |
| Mean           |                    | 49.58   | 59.71 | 64.84 | 71.52 | +21.93   |

Table 14: Complete GameCraft-Bench task scores for Codex + GPT-5.5 (high). Scores use the benchmark’s 0–100 scale; $\Delta$ denotes HoH@3 minus Vanilla.

|  Family        |  Task              | Vanilla | HoH@1 | HoH@2 | HoH@3 | $\Delta$ |
|----------------|--------------------|---------|-------|-------|-------|----------|
| Action         |                    |         |       |       |       |          |
|  Platformer    |  Momentum Lab      | 14.33   | 23.13 | 32.92 | 30.75 | +16.42   |
|                |  Ivory Beats       | 31.73   | 45.78 | 42.09 | 61.08 | +29.35   |
|                |  Thunder Valkyrie  | 19.37   | 28.65 | 52.20 | 60.54 | +41.17   |
|  Shooter       |  Void Patrol       | 37.12   | 57.44 | 53.49 | 57.77 | +20.66   |
|                |  Wave Commander    | 14.74   | 2.31  | 35.61 | 46.46 | +31.71   |
|                |  Hotline Heist     | 33.85   | 12.78 | 33.42 | 38.05 | +4.20    |
|  Roguelike     |  Dungeon Shop      | 39.98   | 41.52 | 53.22 | 46.50 | +6.52    |
|                |  Breach Tactics    | 35.28   | 23.77 | 36.76 | 46.99 | +11.71   |
|                |  Void Harvest      | 9.50    | 14.34 | 49.29 | 52.83 | +43.33   |
| Timing         |                    |         |       |       |       |          |
|  Racing        |  Drift Circuit     | 37.87   | 31.48 | 39.17 | 38.69 | +0.82    |
|                |  Rocket Trials     | 2.41    | 3.02  | 19.90 | 22.68 | +20.27   |
|                |  Trick Runner      | 14.37   | 19.62 | 25.26 | 39.24 | +24.86   |
|  Rhythm        |  Note Highway      | 25.25   | 20.88 | 29.61 | 40.34 | +15.09   |
|                |  Beat Dungeon      | 3.06    | 18.60 | 17.05 | 23.81 | +20.74   |
|                |  Garden            | 49.29   | 58.11 | 55.21 | 63.74 | +14.44   |
|  Sports        |  Skateboard Park   | 19.28   | 24.69 | 46.28 | 57.60 | +38.32   |
|                |  Boxing Gym        | 31.31   | 40.69 | 42.25 | 55.75 | +24.44   |
|                |  Archery Quest     | 33.57   | 29.50 | 54.31 | 63.62 | +30.06   |
| Strategy       |                    |         |       |       |       |          |
|  Strategy      |  Tower Defense     | 29.47   | 25.89 | 39.18 | 49.54 | +20.07   |
|                |  Chess Variant     | 18.76   | 23.69 | 40.45 | 38.51 | +19.75   |
|                |  Spell Tactics     | 15.03   | 35.17 | 21.57 | 42.05 | +27.02   |
|  Card Game     |  Spire Descent     | 13.33   | 4.38  | 19.47 | 23.00 | +9.67    |
|                |  Poker Roguelike   | 20.50   | 24.89 | 38.77 | 57.90 | +37.40   |
|                |  Autobattler       | 30.76   | 18.75 | 23.12 | 18.65 | -12.12   |
|  Puzzle        |  Sokoban Dungeon   | 34.27   | 33.67 | 51.95 | 51.67 | +17.40   |
|                |  Circuit Wizard    | 3.90    | 14.56 | 3.90  | 35.84 | +31.95   |
|                |  Pipe Crisis       | 25.39   | 14.55 | 63.17 | 72.90 | +47.50   |
| Simulation     |                    |         |       |       |       |          |
|  Tycoon        |  Space Colony      | 34.24   | 47.98 | 57.87 | 60.27 | +26.03   |
|                |  Pirate Port       | 25.89   | 61.33 | 52.00 | 52.16 | +26.26   |
|                |  Wildhaven         | 47.66   | 46.52 | 55.13 | 66.07 | +18.41   |
|  Idle          |  Ant Empire        | 40.73   | 42.64 | 55.49 | 49.08 | +8.36    |
|                |  Factory Planet    | 38.17   | 35.20 | 41.02 | 67.84 | +29.66   |
|                |  Dungeon Guild     | 15.66   | 32.89 | 69.71 | 61.34 | +45.67   |
|  Simulation    |  Kitchen Rush      | 33.31   | 33.41 | 36.44 | 39.96 | +6.64    |
|                |  Air Control       | 28.23   | 35.40 | 33.49 | 35.30 | +7.07    |
|                |  Border Check      | 70.22   | 58.34 | 69.22 | 70.74 | +0.52    |
| Adventure      |                    |         |       |       |       |          |
|  Horror        |  Floor 13          | 29.22   | 14.56 | 41.53 | 42.12 | +12.90   |
|                |  Dollhouse         | 8.75    | 10.95 | 13.00 | 54.39 | +45.64   |
|                |  Lighthouse        | 52.11   | 35.78 | 46.30 | 83.33 | +31.23   |
|  Open World    |  Sky Islands       | 24.37   | 11.87 | 28.69 | 46.51 | +22.15   |
|                |  Airship Trader    | 38.94   | 35.41 | 54.64 | 62.37 | +23.42   |
|                |  Bounty            | 7.09    | 13.66 | 0.73  | 25.35 | +18.26   |
|  Visual Novel  |  Detective Noir    | 22.22   | 18.06 | 56.59 | 61.57 | +39.35   |
|                |  Arcane Academy    | 28.76   | 26.72 | 51.36 | 49.05 | +20.29   |
|                |  Time Paradox      | 21.13   | 34.96 | 31.62 | 40.04 | +18.91   |
| Mean           |                    | 26.90   | 28.61 | 40.32 | 48.98 | +22.08   |

Table 15: Complete GameCraft-Bench task scores for OpenCode + DeepSeek-V4-Pro. Scores use the benchmark’s 0–100 scale; $\Delta$ denotes HoH@3 minus Vanilla.

|  Family        |  Task              | Vanilla | HoH@1 | HoH@2 | HoH@3 | $\Delta$ |
|----------------|--------------------|---------|-------|-------|-------|----------|
| Action         |                    |         |       |       |       |          |
|  Platformer    |  Momentum Lab      | 38.28   | 34.49 | 45.03 | 48.80 | +10.52   |
|                |  Ivory Beats       | 36.95   | 39.64 | 39.89 | 42.23 | +5.29    |
|                |  Thunder Valkyrie  | 60.52   | 50.14 | 61.74 | 64.71 | +4.20    |
|  Shooter       |  Void Patrol       | 56.14   | 67.37 | 66.21 | 76.66 | +20.52   |
|                |  Wave Commander    | 69.66   | 64.54 | 72.85 | 75.52 | +5.86    |
|                |  Hotline Heist     | 41.46   | 47.81 | 44.65 | 43.31 | +1.84    |
|  Roguelike     |  Dungeon Shop      | 25.08   | 40.12 | 47.16 | 46.11 | +21.02   |
|                |  Breach Tactics    | 33.70   | 43.79 | 53.61 | 59.56 | +25.86   |
|                |  Void Harvest      | 48.96   | 67.37 | 61.15 | 67.28 | +18.32   |
| Timing         |                    |         |       |       |       |          |
|  Racing        |  Drift Circuit     | 36.91   | 59.79 | 55.68 | 55.24 | +18.33   |
|                |  Rocket Trials     | 35.50   | 38.21 | 37.33 | 42.36 | +6.86    |
|                |  Trick Runner      | 41.79   | 51.66 | 59.92 | 59.50 | +17.71   |
|  Rhythm        |  Note Highway      | 10.35   | 39.65 | 54.91 | 62.58 | +52.23   |
|                |  Beat Dungeon      | 41.75   | 55.41 | 53.18 | 64.83 | +23.08   |
|                |  Garden            | 41.70   | 63.78 | 56.48 | 67.03 | +25.33   |
|  Sports        |  Skateboard Park   | 71.06   | 55.25 | 72.20 | 84.99 | +13.92   |
|                |  Boxing Gym        | 40.44   | 55.00 | 57.71 | 60.53 | +20.09   |
|                |  Archery Quest     | 24.25   | 51.31 | 61.23 | 61.85 | +37.60   |
| Strategy       |                    |         |       |       |       |          |
|  Strategy      |  Tower Defense     | 43.51   | 57.22 | 46.99 | 55.98 | +12.47   |
|                |  Chess Variant     | 24.75   | 31.46 | 27.15 | 30.88 | +6.13    |
|                |  Spell Tactics     | 46.51   | 37.10 | 47.10 | 53.93 | +7.42    |
|  Card Game     |  Spire Descent     | 26.61   | 18.09 | 10.96 | 10.96 | -15.65   |
|                |  Poker Roguelike   | 3.19    | 30.31 | 50.81 | 49.78 | +46.59   |
|                |  Autobattler       | 55.44   | 46.45 | 50.42 | 53.37 | -2.07    |
|  Puzzle        |  Sokoban Dungeon   | 41.98   | 59.80 | 61.21 | 57.66 | +15.68   |
|                |  Circuit Wizard    | 15.50   | 31.61 | 46.89 | 53.51 | +38.01   |
|                |  Pipe Crisis       | 53.26   | 35.39 | 39.39 | 37.65 | -15.61   |
| Simulation     |                    |         |       |       |       |          |
|  Tycoon        |  Space Colony      | 62.72   | 51.54 | 55.76 | 58.33 | -4.39    |
|                |  Pirate Port       | 35.07   | 73.08 | 71.44 | 65.70 | +30.63   |
|                |  Wildhaven         | 58.08   | 57.75 | 61.88 | 65.75 | +7.66    |
|  Idle          |  Ant Empire        | 61.62   | 54.00 | 82.34 | 82.56 | +20.94   |
|                |  Factory Planet    | 44.02   | 54.35 | 77.25 | 80.35 | +36.33   |
|                |  Dungeon Guild     | 73.24   | 63.13 | 70.12 | 73.84 | +0.60    |
|  Simulation    |  Kitchen Rush      | 16.80   | 42.60 | 49.42 | 62.56 | +45.76   |
|                |  Air Control       | 28.61   | 55.82 | 63.76 | 45.69 | +17.08   |
|                |  Border Check      | 53.54   | 33.74 | 36.83 | 43.44 | -10.10   |
| Adventure      |                    |         |       |       |       |          |
|  Horror        |  Floor 13          | 57.29   | 35.94 | 59.74 | 66.60 | +9.31    |
|                |  Dollhouse         | 35.53   | 55.12 | 67.94 | 71.90 | +36.37   |
|                |  Lighthouse        | 60.00   | 76.82 | 73.41 | 74.72 | +14.72   |
|  Open World    |  Sky Islands       | 19.19   | 52.99 | 49.33 | 59.73 | +40.54   |
|                |  Airship Trader    | 44.42   | 52.55 | 56.95 | 60.52 | +16.10   |
|                |  Bounty            | 43.78   | 40.19 | 45.38 | 58.44 | +14.66   |
|  Visual Novel  |  Detective Noir    | 40.87   | 46.41 | 66.07 | 58.16 | +17.29   |
|                |  Arcane Academy    | 51.85   | 42.98 | 45.88 | 65.71 | +13.86   |
|                |  Time Paradox      | 45.44   | 45.99 | 61.56 | 64.22 | +18.78   |
| Mean           |                    | 42.16   | 49.06 | 55.04 | 58.78 | +16.62   |

Table 16: Complete GameCraft-Bench task scores for Pi + MiniMax-M3. Scores use the benchmark’s 0–100 scale; $\Delta$ denotes HoH@3 minus Vanilla.

### C.2 FrontierSWE Per-Task Rewards

Figure [8](#A3.F8 "Figure 8 ‣ C.2 FrontierSWE Per-Task Rewards ‣ Appendix C Complete Experimental Results ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") reports category means under the official FrontierSWE taxonomy. The unequal task counts are shown explicitly on the horizontal axis.

Figure 8: FrontierSWE mean rewards by official category and harness–model configuration.

Tables [17](#A3.T17 "Table 17 ‣ C.2 FrontierSWE Per-Task Rewards ‣ Appendix C Complete Experimental Results ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement")–[19](#A3.T19 "Table 19 ‣ C.2 FrontierSWE Per-Task Rewards ‣ Appendix C Complete Experimental Results ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") report every FrontierSWE task and condition.

|  Task                                   | Vanilla | HoH@1 | HoH@2 | HoH@3 |
|-----------------------------------------|---------|-------|-------|-------|
| Implementation                          |         |       |       |       |
|  Dart Style Haskell                     | 0.00    | 0.06  | 0.07  | 0.16  |
|  Git to Zig                             | 0.18    | 0.18  | 0.17  | 0.18  |
|  Lua Native Compiler                    | 0.52    | 0.60  | 0.72  | 0.70  |
|  PostgreSQL–SQLite Wire Adapter         | 0.14    | 0.15  | 0.15  | 0.15  |
| Performance                             |         |       |       |       |
|  Cranelift Codegen Optimization         | 0.00    | 0.00  | 0.00  | 0.00  |
|  Dependent Type Checker                 | 0.00    | 0.00  | 0.00  | 0.00  |
|  FFmpeg Swscale Rewrite                 | 0.00    | 0.00  | 0.00  | 0.00  |
|  Granite Mamba2 Inference Optimization  | 0.20    | 1.01  | 1.07  | 1.02  |
|  Inference System Optimization          | 0.00    | 0.00  | 0.00  | 0.00  |
|  Libexpat to x86 Assembly               | 0.20    | 0.20  | 0.21  | 0.21  |
|  Notebook Compression                   | 0.00    | 0.69  | 0.69  | 0.69  |
|  Pyright Type-Checking Optimization     | 1.16    | 1.11  | 1.17  | 1.16  |
|  Revideo Performance Optimization       | 0.00    | 0.91  | 0.91  | 0.99  |
| Research                                |         |       |       |       |
|  Optimizer Design                       | 1.40    | 1.71  | 1.46  | 2.00  |
|  PCQM4Mv2 Autoresearch                  | 0.90    | 0.89  | 0.89  | 0.89  |
|  Mean                                   | 0.31    | 0.50  | 0.50  | 0.54  |

Table 17: Complete FrontierSWE task rewards for Codex + GPT-5.5 (high).

|  Task                                   | Vanilla | HoH@1 | HoH@2 | HoH@3 |
|-----------------------------------------|---------|-------|-------|-------|
| Implementation                          |         |       |       |       |
|  Dart Style Haskell                     | 0.02    | 0.04  | 0.05  | 0.04  |
|  Git to Zig                             | 0.13    | 0.17  | 0.17  | 0.17  |
|  Lua Native Compiler                    | 0.02    | 0.02  | 0.03  | 0.25  |
|  PostgreSQL–SQLite Wire Adapter         | 0.15    | 0.14  | 0.15  | 0.15  |
| Performance                             |         |       |       |       |
|  Cranelift Codegen Optimization         | 0.00    | 0.00  | 0.00  | 0.00  |
|  Dependent Type Checker                 | 0.00    | 0.00  | 0.00  | 0.00  |
|  FFmpeg Swscale Rewrite                 | 0.00    | 0.00  | 0.00  | 0.00  |
|  Granite Mamba2 Inference Optimization  | 0.20    | 0.19  | 0.21  | 0.20  |
|  Inference System Optimization          | 0.00    | 0.00  | 0.00  | 0.00  |
|  Libexpat to x86 Assembly               | 0.00    | 0.00  | 0.00  | 0.00  |
|  Notebook Compression                   | 0.00    | 0.00  | 0.00  | 0.00  |
|  Pyright Type-Checking Optimization     | 1.04    | 1.17  | 1.30  | 1.29  |
|  Revideo Performance Optimization       | 0.80    | 0.75  | 0.92  | 0.95  |
| Research                                |         |       |       |       |
|  Optimizer Design                       | 1.14    | 1.55  | 1.55  | 1.57  |
|  PCQM4Mv2 Autoresearch                  | 0.00    | 0.00  | 0.00  | 0.00  |
|  Mean                                   | 0.23    | 0.27  | 0.29  | 0.31  |

Table 18: Complete FrontierSWE task rewards for OpenCode + DeepSeek-V4-Pro.

|  Task                                   | Vanilla | HoH@1 | HoH@2 | HoH@3 |
|-----------------------------------------|---------|-------|-------|-------|
| Implementation                          |         |       |       |       |
|  Dart Style Haskell                     | 0.12    | 0.04  | 0.06  | 0.07  |
|  Git to Zig                             | 0.00    | 0.19  | 0.19  | 0.19  |
|  Lua Native Compiler                    | 0.00    | 0.03  | 0.03  | 0.03  |
|  PostgreSQL–SQLite Wire Adapter         | 0.13    | 0.15  | 0.15  | 0.15  |
| Performance                             |         |       |       |       |
|  Cranelift Codegen Optimization         | 0.00    | 0.00  | 0.00  | 0.00  |
|  Dependent Type Checker                 | 0.00    | 0.00  | 0.00  | 0.00  |
|  FFmpeg Swscale Rewrite                 | 0.00    | 0.00  | 0.00  | 0.00  |
|  Granite Mamba2 Inference Optimization  | 1.06    | 1.97  | 1.98  | 2.18  |
|  Inference System Optimization          | 0.00    | 0.00  | 0.00  | 0.00  |
|  Libexpat to x86 Assembly               | 0.00    | 0.00  | 0.00  | 0.00  |
|  Notebook Compression                   | 0.00    | 0.67  | 0.67  | 0.67  |
|  Pyright Type-Checking Optimization     | 0.00    | 1.18  | 1.18  | 1.17  |
|  Revideo Performance Optimization       | 0.00    | 0.00  | 0.00  | 0.00  |
| Research                                |         |       |       |       |
|  Optimizer Design                       | 2.60    | 2.90  | 2.90  | 2.87  |
|  PCQM4Mv2 Autoresearch                  | 0.00    | 0.88  | 0.88  | 0.88  |
|  Mean                                   | 0.26    | 0.53  | 0.54  | 0.55  |

Table 19: Complete FrontierSWE task rewards for Pi + MiniMax-M3.

### C.3 Budget-Controlled Comparison

The pass-controlled experiment uses Codex with GPT-5.5 (high) on the same 45 GameCraft-Bench tasks under the protocol in Section [B.5](#A2.SS5 "B.5 Baseline and Budget-Controlled Protocols ‣ Appendix B Experimental Protocol ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"). HoH uses three complete planning–coding–testing iterations. Figure [9](#A3.F9 "Figure 9 ‣ C.3 Budget-Controlled Comparison ‣ Appendix C Complete Experimental Results ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") shows how artifact quality and cumulative token use change over the three development passes.

Figure 9: Score and cumulative token trajectories in the budget-controlled GameCraft-Bench comparison using Codex with GPT-5.5 (high). HoH includes planning, coding, and testing at each pass.

Tables [20](#A3.T20 "Table 20 ‣ C.3 Budget-Controlled Comparison ‣ Appendix C Complete Experimental Results ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") and [21](#A3.T21 "Table 21 ‣ C.3 Budget-Controlled Comparison ‣ Appendix C Complete Experimental Results ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") report the task-level scores and cumulative coding-harness tokens, respectively. Averaged over the 45 tasks, Vanilla, three-pass Vanilla Continuation, and HoH obtain scores of 49.58, 58.24, and 71.52 using 2.59M, 6.33M, and 8.41M tokens per task, respectively. By Eq. [12](#A2.E12 "Equation 12 ‣ Model-interaction volume. ‣ B.7 Metrics and Resource Accounting ‣ Appendix B Experimental Protocol ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"), the three-pass conditions gain 2.32 and 3.77 score points per additional million tokens for Vanilla Continuation and HoH, respectively.

|  Task              | Vanilla | Vanilla Cont.@2 | Vanilla Cont.@3 | HoH@3 |
|--------------------|---------|-----------------|-----------------|-------|
| Action             |         |                 |                 |       |
|  Ivory Beats       | 46.81   | 44.58           | 44.84           | 85.42 |
|  Momentum Lab      | 34.05   | 44.51           | 41.15           | 70.61 |
|  Thunder Valkyrie  | 53.51   | 53.44           | 66.41           | 73.67 |
|  Hotline Heist     | 43.37   | 41.70           | 44.21           | 62.81 |
|  Void Patrol       | 58.59   | 74.05           | 72.66           | 87.83 |
|  Wave Commander    | 66.97   | 69.79           | 63.52           | 75.25 |
|  Void Harvest      | 41.05   | 41.06           | 40.60           | 57.43 |
|  Breach Tactics    | 53.44   | 54.04           | 55.93           | 61.09 |
|  Dungeon Shop      | 40.89   | 41.59           | 41.09           | 65.09 |
| Timing             |         |                 |                 |       |
|  Drift Circuit     | 43.58   | 41.72           | 63.77           | 70.08 |
|  Rocket Trials     | 45.19   | 43.81           | 49.82           | 70.31 |
|  Trick Runner      | 51.50   | 48.38           | 53.64           | 64.78 |
|  Beat Dungeon      | 47.94   | 46.70           | 50.41           | 60.81 |
|  Garden            | 52.75   | 56.44           | 58.62           | 70.69 |
|  Note Highway      | 39.44   | 40.84           | 44.28           | 64.68 |
|  Archery Quest     | 58.09   | 66.64           | 72.67           | 76.69 |
|  Boxing Gym        | 43.07   | 52.75           | 56.44           | 73.14 |
|  Skateboard Park   | 57.64   | 68.37           | 67.47           | 81.14 |
| Strategy           |         |                 |                 |       |
|  Chess Variant     | 30.04   | 32.89           | 32.46           | 59.72 |
|  Spell Tactics     | 53.10   | 52.98           | 52.75           | 63.32 |
|  Tower Defense     | 58.85   | 69.76           | 71.02           | 76.92 |
|  Autobattler       | 55.06   | 63.80           | 59.77           | 72.22 |
|  Poker Roguelike   | 44.66   | 48.69           | 51.48           | 69.27 |
|  Spire Descent     | 25.85   | 41.60           | 55.81           | 61.92 |
|  Circuit Wizard    | 31.35   | 34.47           | 36.78           | 49.52 |
|  Pipe Crisis       | 41.88   | 39.64           | 45.39           | 72.17 |
|  Sokoban Dungeon   | 55.75   | 65.11           | 67.14           | 70.13 |
| Simulation         |         |                 |                 |       |
|  Pirate Port       | 51.32   | 48.05           | 72.20           | 77.81 |
|  Space Colony      | 36.87   | 43.97           | 45.09           | 76.55 |
|  Wildhaven         | 49.42   | 60.30           | 64.68           | 80.39 |
|  Ant Empire        | 65.52   | 81.58           | 85.84           | 87.88 |
|  Dungeon Guild     | 63.92   | 72.76           | 75.41           | 79.50 |
|  Factory Planet    | 75.16   | 79.27           | 80.69           | 87.78 |
|  Air Control       | 54.24   | 44.85           | 55.18           | 69.73 |
|  Border Check      | 43.57   | 69.05           | 69.45           | 72.74 |
|  Kitchen Rush      | 42.62   | 58.57           | 54.23           | 73.38 |
| Adventure          |         |                 |                 |       |
|  Dollhouse         | 56.33   | 64.55           | 70.36           | 72.59 |
|  Floor 13          | 48.68   | 65.44           | 66.90           | 73.41 |
|  Lighthouse        | 51.95   | 69.16           | 72.70           | 80.90 |
|  Airship Trader    | 59.58   | 67.71           | 65.15           | 74.41 |
|  Bounty            | 47.00   | 51.46           | 54.09           | 68.27 |
|  Sky Islands       | 53.25   | 61.56           | 63.38           | 68.25 |
|  Arcane Academy    | 59.30   | 54.02           | 52.10           | 70.69 |
|  Detective Noir    | 47.46   | 45.40           | 51.15           | 65.31 |
|  Time Paradox      | 50.63   | 57.48           | 61.92           | 71.97 |
|  Mean              | 49.58   | 54.99           | 58.24           | 71.52 |

Table 20: Task-level scores for the budget-controlled comparison on GameCraft-Bench using Codex + GPT-5.5 (high).

|  Task              | Vanilla | Vanilla Cont.@2 | Vanilla Cont.@3 | HoH@3 |
|--------------------|---------|-----------------|-----------------|-------|
| Action             |         |                 |                 |       |
|  Ivory Beats       | 1.49    | 2.32            | 3.17            | 5.64  |
|  Momentum Lab      | 2.27    | 5.07            | 8.13            | 9.00  |
|  Thunder Valkyrie  | 1.86    | 4.96            | 6.61            | 8.27  |
|  Hotline Heist     | 1.41    | 2.28            | 3.70            | 7.68  |
|  Void Patrol       | 2.42    | 4.21            | 6.39            | 6.55  |
|  Wave Commander    | 2.61    | 4.66            | 5.82            | 9.37  |
|  Void Harvest      | 2.75    | 4.62            | 6.37            | 8.50  |
|  Breach Tactics    | 2.43    | 4.50            | 8.46            | 7.54  |
|  Dungeon Shop      | 2.53    | 4.99            | 6.33            | 6.31  |
| Timing             |         |                 |                 |       |
|  Drift Circuit     | 2.20    | 6.18            | 8.22            | 9.16  |
|  Rocket Trials     | 1.92    | 4.55            | 5.90            | 10.01 |
|  Trick Runner      | 4.13    | 5.83            | 7.68            | 7.65  |
|  Beat Dungeon      | 1.85    | 3.20            | 4.31            | 6.84  |
|  Garden            | 4.57    | 6.08            | 7.59            | 9.65  |
|  Note Highway      | 2.73    | 5.26            | 9.05            | 6.19  |
|  Archery Quest     | 1.51    | 5.62            | 7.24            | 11.16 |
|  Boxing Gym        | 3.25    | 5.19            | 6.55            | 7.82  |
|  Skateboard Park   | 2.41    | 3.31            | 4.44            | 7.63  |
| Strategy           |         |                 |                 |       |
|  Chess Variant     | 1.77    | 2.48            | 5.00            | 9.13  |
|  Spell Tactics     | 2.22    | 3.83            | 5.71            | 7.37  |
|  Tower Defense     | 2.12    | 3.77            | 6.12            | 11.85 |
|  Autobattler       | 2.74    | 4.74            | 6.16            | 10.83 |
|  Poker Roguelike   | 3.41    | 7.13            | 9.29            | 7.35  |
|  Spire Descent     | 2.31    | 4.16            | 6.11            | 11.51 |
|  Circuit Wizard    | 2.06    | 4.13            | 6.70            | 7.01  |
|  Pipe Crisis       | 1.73    | 3.33            | 4.27            | 5.97  |
|  Sokoban Dungeon   | 1.30    | 2.67            | 3.88            | 6.27  |
| Simulation         |         |                 |                 |       |
|  Pirate Port       | 2.43    | 3.32            | 5.81            | 6.69  |
|  Space Colony      | 4.79    | 6.72            | 9.04            | 9.27  |
|  Wildhaven         | 2.58    | 4.01            | 5.22            | 9.93  |
|  Ant Empire        | 3.11    | 4.87            | 6.38            | 11.02 |
|  Dungeon Guild     | 2.41    | 6.81            | 9.33            | 9.28  |
|  Factory Planet    | 3.75    | 6.30            | 7.23            | 9.15  |
|  Air Control       | 3.25    | 5.32            | 7.38            | 7.97  |
|  Border Check      | 1.52    | 3.34            | 4.92            | 7.30  |
|  Kitchen Rush      | 2.36    | 4.19            | 5.18            | 8.98  |
| Adventure          |         |                 |                 |       |
|  Dollhouse         | 1.20    | 2.22            | 3.61            | 8.10  |
|  Floor 13          | 1.68    | 3.25            | 4.90            | 5.81  |
|  Lighthouse        | 2.91    | 4.25            | 6.07            | 8.24  |
|  Airship Trader    | 1.92    | 3.58            | 4.78            | 7.34  |
|  Bounty            | 4.18    | 7.97            | 9.94            | 8.32  |
|  Sky Islands       | 3.60    | 4.78            | 5.72            | 15.71 |
|  Arcane Academy    | 3.59    | 5.39            | 7.70            | 6.56  |
|  Detective Noir    | 3.69    | 4.09            | 4.86            | 8.04  |
|  Time Paradox      | 3.68    | 5.91            | 7.53            | 8.23  |
|  Mean              | 2.59    | 4.56            | 6.33            | 8.41  |

Table 21: Task-level cumulative token usage (M) for the budget-controlled comparison on GameCraft-Bench using Codex + GPT-5.5 (high).

### C.4 Ablation Study

We evaluate three variants of HoH with $T = 3$ on all 45 GameCraft-Bench tasks using Codex with GPT-5.5 (high), following the interventions in Section [B.6](#A2.SS6 "B.6 Ablation Protocols ‣ Appendix B Experimental Protocol ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"). The complete task-level scores are reported in Table [22](#A3.T22 "Table 22 ‣ C.4 Ablation Study ‣ Appendix C Complete Experimental Results ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"). Aggregate token usage is reported separately in Table [23](#A3.T23 "Table 23 ‣ C.4 Ablation Study ‣ Appendix C Complete Experimental Results ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement"). The mean score decreases from 71.52 for full HoH to 63.39 without plan update, 65.23 without evidence feedback, and 63.67 without artifact warm-start. Figure [10](#A3.F10 "Figure 10 ‣ C.4 Ablation Study ‣ Appendix C Complete Experimental Results ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") places the score changes beside their cumulative token use.

Figure 10: Final score and cumulative token use for full HoH and the three cross-iteration ablations on GameCraft-Bench.

|  Task              | Full HoH |  w/o Plan Update  |  w/o Evidence Feedback  |  w/o Warm-Start  |
|--------------------|----------|-------------------|-------------------------|------------------|
| Action             |          |                   |                         |                  |
|  Momentum Lab      | 70.61    | 67.81             | 56.67                   | 58.77            |
|  Ivory Beats       | 85.42    | 69.42             | 80.33                   | 78.85            |
|  Thunder Valkyrie  | 73.67    | 69.99             | 72.94                   | 72.51            |
|  Void Patrol       | 87.83    | 73.22             | 77.79                   | 72.05            |
|  Wave Commander    | 75.25    | 68.74             | 73.28                   | 68.31            |
|  Hotline Heist     | 62.81    | 52.40             | 58.24                   | 35.21            |
|  Dungeon Shop      | 65.09    | 57.73             | 59.33                   | 64.00            |
|  Breach Tactics    | 61.09    | 58.73             | 53.49                   | 52.89            |
|  Void Harvest      | 57.43    | 53.96             | 52.46                   | 53.04            |
| Timing             |          |                   |                         |                  |
|  Drift Circuit     | 70.08    | 63.19             | 66.85                   | 52.81            |
|  Rocket Trials     | 70.31    | 63.56             | 68.15                   | 64.09            |
|  Trick Runner      | 64.78    | 62.55             | 62.45                   | 57.59            |
|  Note Highway      | 64.68    | 63.84             | 61.32                   | 64.51            |
|  Beat Dungeon      | 60.81    | 58.38             | 57.50                   | 50.84            |
|  Garden            | 70.69    | 65.61             | 64.19                   | 67.89            |
|  Skateboard Park   | 81.14    | 75.77             | 75.24                   | 77.44            |
|  Boxing Gym        | 73.14    | 47.90             | 43.73                   | 71.16            |
|  Archery Quest     | 76.69    | 66.11             | 72.52                   | 65.61            |
| Strategy           |          |                   |                         |                  |
|  Tower Defense     | 76.92    | 68.56             | 63.55                   | 51.71            |
|  Chess Variant     | 59.72    | 57.91             | 47.87                   | 51.58            |
|  Spell Tactics     | 63.32    | 50.70             | 58.73                   | 58.81            |
|  Spire Descent     | 61.92    | 46.15             | 60.31                   | 60.21            |
|  Poker Roguelike   | 69.27    | 64.70             | 64.11                   | 58.89            |
|  Autobattler       | 72.22    | 68.39             | 71.42                   | 56.35            |
|  Sokoban Dungeon   | 70.13    | 57.02             | 68.60                   | 64.19            |
|  Circuit Wizard    | 49.52    | 39.38             | 35.48                   | 40.11            |
|  Pipe Crisis       | 72.17    | 62.00             | 61.94                   | 46.91            |
| Simulation         |          |                   |                         |                  |
|  Space Colony      | 76.55    | 57.86             | 75.17                   | 75.14            |
|  Pirate Port       | 77.81    | 75.55             | 70.51                   | 76.69            |
|  Wildhaven         | 80.39    | 79.00             | 79.12                   | 75.22            |
|  Ant Empire        | 87.88    | 78.05             | 82.11                   | 80.69            |
|  Factory Planet    | 87.78    | 70.69             | 83.21                   | 84.36            |
|  Dungeon Guild     | 79.50    | 67.98             | 73.23                   | 76.10            |
|  Kitchen Rush      | 73.38    | 57.69             | 60.10                   | 56.94            |
|  Air Control       | 69.73    | 63.84             | 66.51                   | 64.92            |
|  Border Check      | 72.74    | 65.41             | 62.44                   | 61.16            |
| Adventure          |          |                   |                         |                  |
|  Floor 13          | 73.41    | 68.94             | 69.89                   | 63.37            |
|  Dollhouse         | 72.59    | 60.84             | 60.38                   | 67.71            |
|  Lighthouse        | 80.90    | 72.72             | 74.72                   | 81.50            |
|  Sky Islands       | 68.25    | 62.50             | 63.07                   | 59.85            |
|  Airship Trader    | 74.41    | 61.49             | 69.94                   | 71.21            |
|  Bounty            | 68.27    | 67.41             | 68.20                   | 64.57            |
|  Detective Noir    | 65.31    | 57.41             | 51.77                   | 60.54            |
|  Arcane Academy    | 70.69    | 64.35             | 67.72                   | 57.91            |
|  Time Paradox      | 71.97    | 67.02             | 68.91                   | 70.96            |
|  Mean              | 71.52    | 63.39             | 65.23                   | 63.67            |

Table 22: Task-level GameCraft-Bench ablation scores using Codex + GPT-5.5 (high), with $T = 3$. All values use the benchmark’s 0–100 scale.

| Variant               | Tokens (M) |
|-----------------------|------------|
| w/o Plan Update       | 7.56       |
| w/o Evidence Feedback | 7.46       |
| w/o Warm-Start        | 11.12      |
| Full HoH              | 8.41       |

Table 23: Mean cumulative coding-harness tokens per task for the GameCraft-Bench ablation variants.

### C.5 Resource Usage

Figure [11](#A3.F11 "Figure 11 ‣ C.5 Resource Usage ‣ Appendix C Complete Experimental Results ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") shows the distribution of tokens used by each invocation on the 45 GameCraft-Bench tasks. The panels retain the native provider accounting for each harness–model configuration and should therefore be compared within, rather than across, panels.

Figure 11: Per-invocation coding-harness token distributions on GameCraft-Bench. Points denote tasks; boxes show the median and interquartile range.

Table [24](#A3.T24 "Table 24 ‣ C.5 Resource Usage ‣ Appendix C Complete Experimental Results ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") aggregates the recorded resource use for the FrontierSWE runs.

|                            |         |       |         |       |        |       |        |       |
|----------------------------|---------|-------|---------|-------|--------|-------|--------|-------|
| Harness–model              | Vanilla |       | HoH@1   |       | HoH@2  |       | HoH@3  |       |
|                            | Tokens  | Time  | Tokens  | Time  | Tokens | Time  | Tokens | Time  |
|                            | (M)     | (h)   | (M)     | (h)   | (M)    | (h)   | (M)    | (h)   |
| Codex + GPT-5.5 (high)     | 103.43  | 18.65 | 109.26  | 14.32 | 83.19  | 13.21 | 71.71  | 10.28 |
| OpenCode + DeepSeek-V4-Pro | 384.84  | 32.00 | 332.61  | 23.58 | 345.66 | 23.32 | 229.77 | 16.16 |
| Pi + MiniMax-M3            | 541.73  | 40.19 | 1117.11 | 49.05 | 988.00 | 21.53 | 717.69 | 37.15 |

Table 24: Aggregate FrontierSWE resource usage.

## Appendix D Qualitative Analysis

Figures [12](#A4.F12 "Figure 12 ‣ Appendix D Qualitative Analysis ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement")–[16](#A4.F16 "Figure 16 ‣ Appendix D Qualitative Analysis ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") show one representative game from each of the 15 GameCraft-Bench families. For each family, we select the game with the highest HoH@3 Overall score under Codex with GPT-5.5 (high). Each row compares Vanilla and HoH@1–3; the values beneath each artifact report Overall, Core Mechanics (M), Content Depth (D), Functional Visuals (V), and Art and Presentation (A).

![Refer to caption](2609.01481v1/figS6_action_qualitative.png)

Figure 12: Action: Platformer, Shooter, and Roguelike.

![Refer to caption](2609.01481v1/figS6_timing_qualitative.png)

Figure 13: Timing: Racing, Rhythm, and Sports.

![Refer to caption](2609.01481v1/figS6_strategy_qualitative.png)

Figure 14: Strategy: Strategy, Card Game, and Puzzle.

![Refer to caption](2609.01481v1/figS6_simulation_qualitative.png)

Figure 15: Simulation: Tycoon, Idle, and Simulation.

![Refer to caption](2609.01481v1/figS6_adventure_qualitative.png)

Figure 16: Adventure: Horror, Open World, and Visual Novel.

Table [25](#A4.T25 "Table 25 ‣ Appendix D Qualitative Analysis ‣ Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement") reports the exact Overall and dimension scores underlying all 60 artifacts shown above.

|  Family        |  Game             |  Condition  | Overall | Mechanics | Depth | Visuals | Art   |
|----------------|-------------------|-------------|---------|-----------|-------|---------|-------|
| Action         |                   |             |         |           |       |         |       |
|  Platformer    |  Ivory Beats      |  Vanilla    | 46.81   | 50.00     | 45.00 | 49.17   | 46.25 |
|                |                   |  HoH@1      | 73.28   | 85.00     | 65.00 | 83.44   | 72.19 |
|                |                   |  HoH@2      | 78.55   | 92.00     | 82.00 | 80.42   | 68.54 |
|                |                   |  HoH@3      | 85.42   | 91.00     | 86.00 | 94.06   | 78.75 |
|  Shooter       |  Void Patrol      |  Vanilla    | 58.59   | 90.00     | 50.00 | 65.83   | 50.62 |
|                |                   |  HoH@1      | 73.90   | 93.00     | 64.00 | 75.31   | 75.00 |
|                |                   |  HoH@2      | 76.02   | 100.00    | 66.00 | 77.25   | 75.25 |
|                |                   |  HoH@3      | 87.83   | 97.00     | 90.00 | 89.50   | 81.00 |
|  Roguelike     |  Dungeon Shop     |  Vanilla    | 40.89   | 52.00     | 48.00 | 44.46   | 27.50 |
|                |                   |  HoH@1      | 50.55   | 74.00     | 42.00 | 70.21   | 40.62 |
|                |                   |  HoH@2      | 50.15   | 74.00     | 43.00 | 70.00   | 38.57 |
|                |                   |  HoH@3      | 65.09   | 82.00     | 53.00 | 82.75   | 62.38 |
| Timing         |                   |             |         |           |       |         |       |
|  Racing        |  Rocket Trials    |  Vanilla    | 45.19   | 50.00     | 47.50 | 47.67   | 39.75 |
|                |                   |  HoH@1      | 61.33   | 90.00     | 38.75 | 61.00   | 71.75 |
|                |                   |  HoH@2      | 68.00   | 80.00     | 62.50 | 66.11   | 69.17 |
|                |                   |  HoH@3      | 70.31   | 76.67     | 66.25 | 66.39   | 73.33 |
|  Rhythm        |  Garden           |  Vanilla    | 52.75   | 66.67     | 47.50 | 51.67   | 52.50 |
|                |                   |  HoH@1      | 65.33   | 81.67     | 63.75 | 50.56   | 66.25 |
|                |                   |  HoH@2      | 69.01   | 90.00     | 66.25 | 54.50   | 69.00 |
|                |                   |  HoH@3      | 70.69   | 100.00    | 68.75 | 52.50   | 67.88 |
|  Sports        |  Skateboard Park  |  Vanilla    | 57.64   | 75.00     | 60.00 | 30.00   | 59.69 |
|                |                   |  HoH@1      | 69.51   | 73.33     | 70.00 | 67.50   | 68.25 |
|                |                   |  HoH@2      | 72.62   | 76.67     | 76.25 | 75.00   | 66.25 |
|                |                   |  HoH@3      | 81.14   | 90.00     | 85.00 | 80.00   | 73.96 |
| Strategy       |                   |             |         |           |       |         |       |
|  Strategy      |  Tower Defense    |  Vanilla    | 58.85   | 65.00     | 67.50 | 67.75   | 43.75 |
|                |                   |  HoH@1      | 63.97   | 67.50     | 66.25 | 80.75   | 53.00 |
|                |                   |  HoH@2      | 64.12   | 67.50     | 70.00 | 77.08   | 51.25 |
|                |                   |  HoH@3      | 76.92   | 73.75     | 75.00 | 90.25   | 74.50 |
|  Card Game     |  Autobattler      |  Vanilla    | 55.06   | 75.00     | 65.00 | 44.17   | 41.25 |
|                |                   |  HoH@1      | 72.39   | 86.67     | 76.25 | 61.67   | 67.00 |
|                |                   |  HoH@2      | 71.28   | 86.67     | 80.00 | 49.72   | 65.21 |
|                |                   |  HoH@3      | 72.22   | 91.67     | 75.00 | 61.67   | 65.62 |
|  Puzzle        |  Pipe Crisis      |  Vanilla    | 41.88   | 50.00     | 36.25 | 55.83   | 38.06 |
|                |                   |  HoH@1      | 65.07   | 86.25     | 48.75 | 81.33   | 65.33 |
|                |                   |  HoH@2      | 68.65   | 92.50     | 58.75 | 79.76   | 63.57 |
|                |                   |  HoH@3      | 72.17   | 100.00    | 60.00 | 81.67   | 68.33 |
| Simulation     |                   |             |         |           |       |         |       |
|  Tycoon        |  Wildhaven        |  Vanilla    | 49.42   | 52.00     | 44.17 | 73.33   | 43.33 |
|                |                   |  HoH@1      | 74.09   | 91.00     | 72.50 | 85.00   | 63.75 |
|                |                   |  HoH@2      | 77.78   | 89.00     | 81.67 | 91.67   | 63.12 |
|                |                   |  HoH@3      | 80.39   | 90.00     | 87.50 | 95.00   | 62.89 |
|  Idle          |  Ant Empire       |  Vanilla    | 65.52   | 93.33     | 68.75 | 35.00   | 63.44 |
|                |                   |  HoH@1      | 71.42   | 100.00    | 63.75 | 57.50   | 72.81 |
|                |                   |  HoH@2      | 69.64   | 96.67     | 67.50 | 45.00   | 70.75 |
|                |                   |  HoH@3      | 87.88   | 100.00    | 85.00 | 92.50   | 83.57 |
|  Simulation    |  Kitchen Rush     |  Vanilla    | 42.62   | 67.00     | 42.00 | 40.00   | 33.93 |
|                |                   |  HoH@1      | 48.07   | 73.00     | 49.00 | 47.81   | 36.56 |
|                |                   |  HoH@2      | 65.64   | 90.00     | 68.00 | 65.25   | 53.00 |
|                |                   |  HoH@3      | 73.38   | 100.00    | 72.00 | 72.92   | 63.54 |
| Adventure      |                   |             |         |           |       |         |       |
|  Horror        |  Lighthouse       |  Vanilla    | 51.95   | 61.67     | 65.00 | 35.00   | 42.00 |
|                |                   |  HoH@1      | 63.89   | 65.00     | 63.75 | 50.00   | 69.50 |
|                |                   |  HoH@2      | 71.47   | 78.33     | 75.00 | 57.50   | 71.00 |
|                |                   |  HoH@3      | 80.90   | 86.67     | 86.25 | 70.00   | 77.75 |
|  Open World    |  Airship Trader   |  Vanilla    | 59.58   | 73.33     | 48.75 | 45.00   | 70.75 |
|                |                   |  HoH@1      | 73.60   | 90.00     | 67.50 | 95.00   | 63.50 |
|                |                   |  HoH@2      | 74.40   | 90.00     | 70.00 | 90.00   | 65.42 |
|                |                   |  HoH@3      | 74.41   | 95.00     | 70.00 | 87.50   | 64.38 |
|  Visual Novel  |  Time Paradox     |  Vanilla    | 50.63   | 77.00     | 60.00 | 40.31   | 34.38 |
|                |                   |  HoH@1      | 63.28   | 77.00     | 64.00 | 60.62   | 57.81 |
|                |                   |  HoH@2      | 71.15   | 79.00     | 70.00 | 77.92   | 66.04 |
|                |                   |  HoH@3      | 71.97   | 90.00     | 66.00 | 86.61   | 63.93 |

Table 25: Scores for the 15 GameCraft-Bench games shown in the qualitative comparison. One game is selected per benchmark family by the highest HoH@3 Overall score under Codex with GPT-5.5 (high).
