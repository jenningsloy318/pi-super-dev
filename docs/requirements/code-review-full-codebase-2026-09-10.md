# Comprehensive Codebase Review: pi-super-dev

Status: REVIEW REPORT — 18 findings (2 Critical / 6 High / 7 Medium / 3 Low); Critical #1 + #2 and High #3 folded into the v0.3.85 wave (Group 1); Highs #4-#8 + Mediums/Lows queued for post-wave commits

**Date:** 2026-09-10  
**Scope:** Entire repository codebase (`src/**/*.ts`, root configuration, control schemas, runtime architecture)  
**Author:** Senior Staff Engineer / Code Review Expert  
**Target Version:** v0.3.84  
**Output Target:** `docs/requirements/code-review-full-codebase-2026-09-10.md`  

---

## 1. Executive Summary

### 1.1 Repository Shape and Architecture
`pi-super-dev` is a self-contained, 13-stage software development pipeline extension for the Pi coding agent ecosystem. It coordinates autonomous LLM specialist subagents across the entire software delivery lifecycle (requirements analysis, BDD specification, research, design, prototyping, contract verification, test-driven implementation, review convergence, documentation, and pull request / merge workflows).

The codebase comprises **84 TypeScript source files** spanning approximately **25,400 lines of code (LoC)** in `src/`. The engine is architected around:
- A composable node algebra (`src/nodes.ts`) providing primitives for sequence, branch, parallel, loop, retry, and gate execution.
- A 4,000-line per-phase TDD implementation engine (`src/stages/implementation.ts`) governing deterministic test execution, RED/GREEN phase boundaries, and foreign worktree dirt quarantine.
- An LLM-based diagnostic routing judge (`src/stages/judge.ts`) and closed-loop cross-stage replan circuit (`src/replan/`).
- Formal TypeBox schema validation layers (`src/render/schemas.ts`) enforcing structured outputs across agent delegation boundaries (`src/agents/delegation-backend.ts`).

### 1.2 Review Methodology
The review applied a senior engineering lens focused on:
1. **Correctness Bugs:** Logic errors, off-by-one errors, parser discrepancies, and state mismatches.
2. **Concurrency & Asynchrony:** Unhandled rejections, race conditions on shared filesystem ledgers, missing synchronization across parallel branches, and termination bounds.
3. **Security:** Arbitrary filesystem traversal, command injection vectors in process lifecycles, ReDoS vulnerabilities, and process isolation boundaries.
4. **Error Handling & State Conservation:** Swallowed errors, fail-open vs. fail-closed doctrine compliance, and state corruption across restart boundaries.
5. **Type Safety & Contract Drift:** Schema-to-consumer mismatches, unchecked type assertions, and prompt-to-schema drift.
6. **Repository Constitution Compliance:** Direct audit against the repository's 10 Engineering Principles (`docs/methodology/00-principles.md`, P1–P10).

### 1.3 Findings Summary by Severity

| Severity | Count | Real Bugs | Risks | Smells |
| :--- | :---: | :---: | :---: | :---: |
| **Critical** | **2** | 2 | 0 | 0 |
| **High** | **6** | 4 | 2 | 0 |
| **Medium** | **7** | 3 | 3 | 1 |
| **Low** | **3** | 0 | 1 | 2 |
| **Total** | **18** | **9** | **6** | **3** |

### 1.4 Overall Risk Assessment
The architecture demonstrates exceptional defensive engineering in many domains—notably the provenance-aware worktree dirt isolation, multi-stage failure signature hashing, deterministic gate precedence tiers, and atomic file replacement primitives.

However, **two critical contract bugs in the TypeBox schema layer** currently threaten pipeline stability:
1. `JudgeControlData` declares `evidence` as an array of strings, while `judge.ts` and the judge prompt mandate and parse `{file, quote}` objects. This guarantees a TypeBox schema validation rejection on conforming LLM judge outputs, breaking the engine's primary escape valve.
2. `FileClassifyControlData` requires `allowed: boolean` and `source: string`, which `buildRedBoundaryPrompt` never asks the agent for, triggering systematic schema rejections in RED boundary classification.

Additionally, **high-severity risks** exist in uncontained filesystem reads in the judge verifier, an innermost-object parsing bug in fallback JSON extraction, silent loss of human-owned replan requests, unconstrained shell execution in service lifecycle bringup, and uncoordinated concurrent writes to `.knowledge.json` during parallel review stages. Addressing these issues will significantly harden the pipeline against operational deadlocks and security vulnerabilities.

---

## 2. Methodology & Coverage

### 2.1 Deeply Reviewed Modules
- **Engine Core (Tier 1):**
  - `src/stages/implementation.ts` (attempt loop, RED/GREEN phase boundaries, salvage attribution, porcelain dirt quarantine, partial phase reverification).
  - `src/stages/judge.ts` (evidence verification, containment check, timeout retry, corrective re-call loop, judge outcome routing).
  - `src/build-runner/gates.ts` (deterministic build gate, deliverable contracts, `tolerantMatch`, `deliverablesAlreadyMet`).
  - `src/fault-classification.ts` (provenance-aware gate fault classification, signature noise stripping, canonical quarantine inventory).
  - `src/stages/plan-feasibility.ts` (static contradiction validation, cross-phase identifier checking, fast-fail framing).
- **Replan Circuit (Tier 2):**
  - `src/replan/owners.ts` (deterministic rule hierarchy and closed owner set).
  - `src/replan/lead.ts` (replan-lead prompt, evidence quote validation, confidence floor).
  - `src/replan/replan.ts` (replan request persistence, resume cache prefix invalidation, fingerprinting, auto-resume trigger).
- **Contract Surface & Schemas (Tier 3):**
  - `src/render/schemas.ts` (all TypeBox definitions, `STAGE_MODELS`, standalone control schemas).
  - Cross-checked against all consumers in `src/stages/`, `src/prompts.ts`, and `src/agents/delegation-backend.ts`.
- **Agent Runtime & Extension Wiring (Tier 4):**
  - `src/agents/agent-runtime.ts` (extension package resolution, tool indexing, commit-guard wiring).
  - `src/agents/delegation-backend.ts` (event-bus RPC, structured output validation, backoff and retry mechanisms).
  - `src/extension.ts` (Pi extension activation, `activeRun` singleton, session shutdown handling, stagnation prompts).
  - `src/harness-paths.ts` (centralized bookkeeping basename registry).
- **Supporting Architecture (Tier 5):**
  - `src/control.ts` (JSON tag and fallback parser, unescaped quote repair).
  - `src/workflow.ts` (runWorkflow orchestration, `realAgent`, source boundary enforcement).
  - `src/setup.ts` (worktree setup, lock acquisition, task slugification).
  - `src/stages/verify.ts` (review step parallelization, stagnation tracking).
  - `src/stages/lifecycle.ts` (service process bringup and shutdown).
  - `src/safety.ts` & `src/child-guards/commit-guard.ts` (tool hooks, command classifiers).

### 2.2 Compilation and Type-Check Verification
Reviewers inspected type declarations against NodeNext module resolution and TypeScript 5.4 specifications. Type errors and cast safety (`as`, `any`) were audited manually at all cross-module contract boundaries.

---

## 3. Findings Summary Table

| ID | Severity | Class | File:Line | One-Line Summary |
| :--- | :--- | :--- | :--- | :--- |
| **FINDING-01** | **Critical** | real-bug | `src/render/schemas.ts:30` | `JudgeControlData` defines `evidence` as string array; `judge.ts` and prompt require `{file, quote}` objects, breaking all judge calls. |
| **FINDING-02** | **Critical** | real-bug | `src/render/schemas.ts:44-50` | `FileClassifyControlData` requires `allowed` and `source` in `classifications`; prompt omits them, causing schema violations. |
| **FINDING-03** | **High** | risk | `src/stages/judge.ts:153, 201` | Absolute paths bypass containment check, and `boundedRead` uses `readFileSync` synchronously before length-capping (hang/OOM on `/dev/zero`). |
| **FINDING-04** | **High** | real-bug | `src/build-runner/gates.ts:1920` | `deliverablesAlreadyMet` and `reverifyPartialPhases` omit `requireTests`, allowing false greens and vacuous skips. |
| **FINDING-05** | **High** | real-bug | `src/control.ts:285` | `findLastJsonObject` uses `lastIndexOf("{")`, extracting only innermost nested JSON rather than the outermost object. |
| **FINDING-06** | **High** | real-bug | `src/replan/replan.ts:427` | Human-owned replan requests are pushed in memory but discarded without disk write when `newRequests.length === 0`. |
| **FINDING-07** | **High** | risk | `src/stages/lifecycle.ts:129` | Model-discovered service command runs via `shell: true` with full host environment, guarded only by an incomplete regex denylist. |
| **FINDING-08** | **High** | risk | `src/render/knowledge.ts:45` | Unlocked concurrent read-modify-write in `appendToKnowledge` causes data loss during parallel Stage 10 reviews. |
| **FINDING-09** | **Medium** | risk | `src/prompts.ts:37` | Unsynchronized document index calculation in `nextDocNumber` causes colliding doc numbers during parallel reviews. |
| **FINDING-10** | **Medium** | risk | `src/setup.ts:450` | TOCTOU file-lock race in `acquireRunLock` allows competing process to treat empty lock file as corrupted and steal it. |
| **FINDING-11** | **Medium** | real-bug | `src/replan/replan.ts:252` | `fingerprintFinding` hashes unclassified `f.ownerStage` instead of target owner, causing distinct blockers with empty `ownerStage` to collide. |
| **FINDING-12** | **Medium** | risk | `src/stages/plan-feasibility.ts:147` | `identifierAvailableAtHead` joins model-derived paths without worktree containment check, allowing path traversal. |
| **FINDING-13** | **Medium** | smell | `src/safety.ts:144` | Safety hook factory in `safety.ts` is only called in test bench, leaving production subagents running without bash denylist. |
| **FINDING-14** | **Medium** | real-bug | `src/build-runner/gates.ts:1242` | `tolerantMatch` evaluates arbitrary literal patterns as regular expressions without escaping metacharacters, causing false pattern matches. |
| **FINDING-15** | **Medium** | risk | `src/agents/agent-runtime.ts:347` | `buildToolIndexFromTools` extracts scoped packages with backslashes on Windows (`@scope\pkg`), breaking package tool resolution. |
| **FINDING-16** | **Low** | smell | `src/extension.ts:1047` | Background `runPostMortem` promise is unawaited and not registered in `session_shutdown` lifecycle tracker. |
| **FINDING-17** | **Low** | smell | `src/stages/implementation.ts:1363` | Exported function name `attributQuarantinedViolations` contains a typographical spelling error (missing 'e'). |
| **FINDING-18** | **Low** | smell | `src/stages/verify.ts:1436` | Multiple `continue` statements in Stage 10 loops lack explicit comments documenting termination bounds (P8 violation). |

---

## 4. Detailed Findings

---

### FINDING-01: Contract Mismatch Between `JudgeControlData` Schema and `judge.ts` Execution Engine
- **Severity:** Critical (P0)
- **Class:** real-bug
- **File & Line:** `src/render/schemas.ts:30` (cross-ref: `src/stages/judge.ts:252-258`, `src/prompts.ts:552`)

#### Code Snippet
In `src/render/schemas.ts`:
```typescript
export const JudgeControlData = Type.Object({
	diagnosis: Type.String({ description: "one-paragraph root-cause diagnosis" }),
	route: Type.Union([
		Type.Literal("re-author-tests"), Type.Literal("challenge-test"),
		Type.Literal("fix-environment"), Type.Literal("implementer-retry"),
		Type.Literal("replan-upstream"), Type.Literal("allow-scaffold"),
		Type.Literal("continue"), Type.Literal("escalate-now"),
	], { description: "one of the JUDGE_ROUTES values (stages/judge.ts)" }),
	confidence: Type.Number({ minimum: 0, maximum: 1 }),
	evidence: Type.Array(Type.String(), { minItems: 1, description: "file:line or quoted-log evidence" }),
});
```

In `src/stages/judge.ts`:
```typescript
const evidenceRaw = Array.isArray(control.evidence) ? control.evidence : [];
const evidence: JudgeEvidence[] = evidenceRaw
	.slice(0, MAX_EVIDENCE_ITEMS)
	.map((e) => {
		const o = (e ?? {}) as Record<string, unknown>;
		return { file: String(o.file ?? ""), quote: String(o.quote ?? "") };
	});
```

#### Why It Is Wrong
There is a direct type contract contradiction between the schema and the parsing code:
1. `JudgeControlData` in `src/render/schemas.ts:30` specifies `evidence` as an array of strings (`Type.Array(Type.String())`).
2. `src/prompts.ts:552` (`buildJudgePrompt`) explicitly instructs the LLM:
   > "3. For every route except continue, provide 1-5 evidence items {file, quote}; quote must be 8-200 characters copied VERBATIM from that file or from the captured output in the context."
   > "evidence (array of {file, quote}; use [] only for route=continue)"
3. In `src/stages/judge.ts:308`, the judge call passes `schema: JudgeControlData`.
4. In `src/agents/delegation-backend.ts:554`, `schemaViolationErrors` validates the agent's output against `opts.schema` using TypeBox `Value.Errors`.

#### Impact Scenario
When the judge model follows its prompt and returns `{ file: "src/foo.ts", quote: "bar" }` objects in `evidence`, TypeBox validation rejects the response with `/evidence/0: Expected string`. A corrective retry is triggered. If the model switches to strings (e.g. `["src/foo.ts: bar"]`), `parseJudgeControl` attempts to read `o.file` and `o.quote` on a string, yielding `file: ""` and `quote: ""`. In `verifyJudgeEvidence`, `allEmpty` becomes `true`, causing the verdict to be flagged as `evidence is malformed: every item is empty/whitespace` and discarded. Consequently, the LLM Judge mechanism is unusable.

#### Concrete Actionable Fix
Update `JudgeControlData` in `src/render/schemas.ts` to accept `{file, quote}` objects (or a union supporting canonical strings) matching `JudgeEvidence`:
```typescript
export const JudgeEvidenceSchema = Type.Object({
	file: Type.String({ description: "repo-relative file path or captured output source" }),
	quote: Type.String({ minLength: 8, maxLength: 200, description: "verbatim quote from file or output" }),
});

export const JudgeControlData = Type.Object({
	diagnosis: Type.String({ description: "one-paragraph root-cause diagnosis" }),
	route: Type.Union([
		Type.Literal("re-author-tests"), Type.Literal("challenge-test"),
		Type.Literal("fix-environment"), Type.Literal("implementer-retry"),
		Type.Literal("replan-upstream"), Type.Literal("allow-scaffold"),
		Type.Literal("continue"), Type.Literal("escalate-now"),
	], { description: "one of the JUDGE_ROUTES values (stages/judge.ts)" }),
	confidence: Type.Number({ minimum: 0, maximum: 1 }),
	evidence: Type.Array(Type.Union([JudgeEvidenceSchema, Type.String()]), {
		description: "array of {file, quote} objects or canonical '<file>: <quote>' strings",
	}),
});
```

---

### FINDING-02: Contract Mismatch Between `FileClassifyControlData` and Boundary Classifiers
- **Severity:** Critical (P0)
- **Class:** real-bug
- **File & Line:** `src/render/schemas.ts:44-50` (cross-ref: `src/test-artifacts.ts:273, 289`, `src/stages/implementation.ts:639`, `src/stages/verify.ts:595`)

#### Code Snippet
In `src/render/schemas.ts`:
```typescript
export const FileClassifyControlData = Type.Object({
	classifications: Type.Array(Type.Object({
		path: Type.String(),
		category: Type.String({ description: "test | production | config | tooling | ambiguous" }),
		allowed: Type.Boolean(),
		source: Type.String({ description: "deterministic | agent" }),
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
	})),
	forbiddenFiles: Type.Array(Type.String()),
	ambiguousFiles: Type.Array(Type.String()),
	allAllowed: Type.Boolean(),
});
```

In `src/test-artifacts.ts:289`:
```typescript
"Return structured_output with:",
"- classifications: [{ path, category: 'test'|'support'|'runtime'|'scaffold'|'production'|'ambiguous'|'substrate', confidence: 0..1, reason }]",
"- forbiddenFiles: production or unsafe paths",
"- ambiguousFiles: paths you cannot confidently allow",
"- allAllowed: true only when every changed file is safe for RED",
```

In `src/test-artifacts.ts:273`:
```typescript
const allowed = isAllowedCategory(category) && confidence >= MIN_AGENT_CONFIDENCE;
return decision(path, category, allowed, confidence, "agent", allowed ? reason : `${reason}; denied by RED boundary policy`);
```

#### Why It Is Wrong
`FileClassifyControlData` declares `allowed: Type.Boolean()` and `source: Type.String()` as **required** properties on each element in `classifications`. However, `buildRedBoundaryPrompt` asks the model for `{ path, category, confidence, reason }` and explicitly does *not* ask for `allowed` or `source`. The harness code in `redBoundaryResultFromAgent` derives `allowed` and sets `source = "agent"` deterministically.

#### Impact Scenario
Whenever `resolveRedBoundary` (`src/stages/implementation.ts:639`) or `detectIntegrationWriteViolations` (`src/stages/verify.ts:595`) invokes the `red-boundary-classifier` agent with `schema: FileClassifyControlData`, any conforming agent output fails TypeBox validation due to missing required properties `/classifications/0/allowed` and `/classifications/0/source`. The delegation backend triggers corrective retries, wasting tokens and wall-clock time before degrading to fallback classification.

#### Concrete Actionable Fix
Mark `allowed` and `source` optional in `FileClassifyControlData`, and add optional `reason`:
```typescript
export const FileClassifyControlData = Type.Object({
	classifications: Type.Array(Type.Object({
		path: Type.String(),
		category: Type.String({ description: "test | support | runtime | scaffold | production | ambiguous | substrate" }),
		allowed: Type.Optional(Type.Boolean()),
		source: Type.Optional(Type.String({ description: "deterministic | agent" })),
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
		reason: Type.Optional(Type.String()),
	})),
	forbiddenFiles: Type.Array(Type.String()),
	ambiguousFiles: Type.Array(Type.String()),
	allAllowed: Type.Boolean(),
});
```

---

### FINDING-03: Absolute Path Containment Bypass and Synchronous Unbounded Read in `verifyJudgeEvidence`
- **Severity:** High (P1)
- **Class:** risk (security / availability)
- **File & Line:** `src/stages/judge.ts:153-158, 201-209`

#### Code Snippet
In `src/stages/judge.ts`:
```typescript
function boundedRead(path: string): string {
	try {
		const buf = readFileSync(path);
		return buf.length > VERIFY_FILE_CAP ? buf.subarray(0, VERIFY_FILE_CAP).toString("utf8") : buf.toString("utf8");
	} catch {
		return "";
	}
}
```
and:
```typescript
const resolved = isAbsolute(file) ? file : join(worktreePath, file.replace(/^\.\//, ""));
if (!existsSync(resolved)) { failures.push(`evidence[${i}]: file not found: ${file}`); continue; }
if (!isAbsolute(file)) {
	let real: string;
	try { real = realpathSync(resolved); } catch { real = resolved; }
	const root = worktreeReal ?? worktreePath;
	if (real !== root && !real.startsWith(root + sep)) {
		failures.push(`evidence[${i}]: file resolves outside the worktree: ${file}`);
		continue;
	}
}
if (!boundedRead(resolved).includes(quote)) { ... }
```

#### Why It Is Wrong
1. **Containment Bypass:** `if (!isAbsolute(file))` restricts containment checks exclusively to relative paths. If the judge agent supplies an absolute path (e.g. `/etc/passwd`, `/dev/zero`, or paths in other users' home directories), the worktree containment check is skipped entirely.
2. **Synchronous Hang / OOM:** `boundedRead` executes `readFileSync(path)` without size limits before checking `buf.length > VERIFY_FILE_CAP`. On Linux systems, `readFileSync("/dev/zero")` or a named FIFO pipe will hang the Node.js event loop indefinitely or allocate until an out-of-memory exception terminates the host process.

#### Impact Scenario
A compromised or prompt-injected judge agent can reference `/dev/zero` or `/dev/random` in `evidence.file`, causing `runJudge` to hang indefinitely and freezing the entire super-dev host process. Furthermore, an agent can verify the presence and content of arbitrary files on the host filesystem outside the repository.

#### Concrete Actionable Fix
1. Validate file descriptors using `statSync`: verify that `stat.isFile()` is true (reject character devices, FIFOs, and sockets) and check `stat.size`.
2. Restrict absolute paths to approved directory trees (`worktreePath`, `specDirectory`, or OS temp directory).
3. Read at most `VERIFY_FILE_CAP` bytes using `fs.openSync` + `fs.readSync`:
```typescript
function boundedRead(path: string): string {
	try {
		const st = statSync(path);
		if (!st.isFile()) return "";
		const fd = openSync(path, "r");
		try {
			const buf = Buffer.alloc(Math.min(st.size, VERIFY_FILE_CAP));
			readSync(fd, buf, 0, buf.length, 0);
			return buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}
```

---

### FINDING-04: `deliverablesAlreadyMet` and `reverifyPartialPhases` Omit `requireTests`
- **Severity:** High (P1)
- **Class:** real-bug
- **File & Line:** `src/build-runner/gates.ts:1920-1925` & `src/stages/implementation.ts:850-855`

#### Code Snippet
In `src/build-runner/gates.ts:1920`:
```typescript
const files = deliverables.requireFiles;
const contains = deliverables.requireContains ?? [];
const notContains = deliverables.requireNotContains ?? [];
const scenarios = normalizeScenarioTags(deliverables.requireScenarios);
const hasCheckableClause = (Array.isArray(files) && files.length > 0)
	|| contains.length > 0
	|| notContains.length > 0
	|| scenarios.length > 0;
if (!hasCheckableClause) return false;
```

In `src/stages/implementation.ts:851`:
```typescript
const d = deliverables as { requireFiles?: unknown[]; requireContains?: unknown[]; requireScenarios?: unknown[] };
const affirmative = (d.requireFiles?.length ?? 0) + (d.requireContains?.length ?? 0) + (d.requireScenarios?.length ?? 0);
if (affirmative === 0) {
	skippedVacuous.push(`${id} (no affirmative clause)`);
	return; // notContains-only: vacuously satisfiable — never flip
}
```

#### Why It Is Wrong
`PhaseDeliverables` in `src/render/schemas.ts` supports five clause types: `requireFiles`, `requireContains`, `requireNotContains`, `requireTests`, and `requireScenarios`.
1. In `deliverablesAlreadyMet`, `requireTests` is completely missing from `hasCheckableClause` and is never verified against the test runner output.
2. In `reverifyPartialPhases`, `d.requireTests` is omitted from `affirmative`, causing any phase whose sole deliverable is test execution to be rejected with `(no affirmative clause)`.
This violates Principle P6/P7 (incomplete grammar coverage across sibling modules).

#### Impact Scenario
1. If an implementation phase defines `requireFiles` and `requireTests`, `deliverablesAlreadyMet` will report `true` on resume even if none of the required tests exist or pass.
2. At the end of Stage 9, `reverifyPartialPhases` skips legitimate test-only phases, falsely marking them as vacuous instead of checking if their tests now pass.

#### Concrete Actionable Fix
Include `deliverables.requireTests` in `hasCheckableClause` and execute test-list verification in `deliverablesAlreadyMet`. In `reverifyPartialPhases`, include `(d.requireTests?.length ?? 0)` in `affirmative`.

---

### FINDING-05: `findLastJsonObject` Extracts Innermost Nested JSON Rather Than Outermost Object
- **Severity:** High (P1)
- **Class:** real-bug
- **File & Line:** `src/control.ts:285-308`

#### Code Snippet
In `src/control.ts`:
```typescript
export function findLastJsonObject(text: string): string | null {
	const lastOpen = text.lastIndexOf("{");
	if (lastOpen === -1) return null;
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = lastOpen; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escape) escape = false;
			else if (ch === "\\") escape = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(lastOpen, i + 1);
		}
	}
	return null;
}
```

#### Why It Is Wrong
`text.lastIndexOf("{")` finds the *last* opening brace in the entire text stream. If the LLM produces a top-level control object that contains nested sub-objects (e.g. `{ "diagnosis": "x", "details": { "key": "val" } }`), `text.lastIndexOf("{")` indexes the brace before `"key"`. Scanning forward from that inner brace extracts only `{"key": "val"}`.

#### Impact Scenario
When an agent omits `<control>` tags and ```json fences, fallback extraction invokes `findLastJsonObject`. Because it extracts only the innermost object, `extractControlFallback` checks if `{"key": "val"}` contains top-level keys like `diagnosis` or `route`. Finding none, it rejects the candidate as a decoy and returns `null`. An otherwise valid control object is discarded.

#### Concrete Actionable Fix
Scan backward from the last `}` or scan forward from all `{` candidates to locate the outermost matching JSON object, or find all balanced objects and choose the last outermost object:
```typescript
export function findLastJsonObject(text: string): string | null {
	const candidates: string[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "{") continue;
		let depth = 0;
		let inString = false;
		let escape = false;
		for (let j = i; j < text.length; j++) {
			const ch = text[j];
			if (inString) {
				if (escape) escape = false;
				else if (ch === "\\") escape = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					candidates.push(text.slice(i, j + 1));
					i = j; // advance past this balanced object
					break;
				}
			}
		}
	}
	return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}
```

---

### FINDING-06: Human-Owned Replan Requests Discarded in Memory When `newRequests.length === 0`
- **Severity:** High (P1)
- **Class:** real-bug
- **File & Line:** `src/replan/replan.ts:427-443`

#### Code Snippet
In `src/replan/replan.ts`:
```typescript
file.requests.push(...humanRequests);
if (newRequests.length === 0) {
	// Every routable finding was already requested before and none has been
	// addressed — that is a stall on the owning stage, not a fresh round.
	ctx.log("Stage 10: all routable findings already have pending replan requests — falling through to the human boundary");
	appendAudit(setup.specDirectory, { event: "duplicate-requests", routable: routable.length });
	return false;
}
file.rounds += 1;
if (!writeJson(requestsPath, file)) return false;
```

#### Why It Is Wrong
`humanRequests` are findings classified with `ownerStage: "human"` that must be surfaced at the HITL boundary. Line 427 pushes `humanRequests` into the in-memory array `file.requests`. However, if all machine-routable requests are already pending (`newRequests.length === 0`), the function returns `false` at line 434 *before* reaching `writeJson(requestsPath, file)` at line 443.

#### Impact Scenario
When routable findings are already pending, any newly classified human-owned findings are silently discarded from disk. They are not persisted to `replan-requests.json`. When the user or extension resumes and calls `pendingHumanReplanRequests`, the newly discovered human findings are missing. This violates requirement M10 / AC-20.

#### Concrete Actionable Fix
Persist `file` if `humanRequests.length > 0`, even when `newRequests.length === 0`:
```typescript
file.requests.push(...humanRequests);
if (humanRequests.length > 0 && newRequests.length === 0) {
	writeJson(requestsPath, file);
}
if (newRequests.length === 0) {
	ctx.log("Stage 10: all routable findings already have pending replan requests — falling through to the human boundary");
	appendAudit(setup.specDirectory, { event: "duplicate-requests", routable: routable.length });
	return false;
}
```

---

### FINDING-07: Model-Discovered Service Command Executed via `shell: true` with Host Environment
- **Severity:** High (P1)
- **Class:** risk (security)
- **File & Line:** `src/stages/lifecycle.ts:113-135`

#### Code Snippet
In `src/stages/lifecycle.ts`:
```typescript
const safety = checkBashCommand(spec.cmd);
if (safety.blocked) {
	return { role: spec.role, baseUrl: `http://127.0.0.1:${port}`, pid: -1, port, cmd: spec.cmd, external: false, ready: false };
}
const env: Record<string, string> = {
	...(process.env as Record<string, string>),
	...loadDotEnv(spec.cwd),
	...(spec.env ?? {}),
	...(spec.portEnv ? { [spec.portEnv]: String(port) } : {}),
};
const child = spawn(spec.cmd, {
	cwd: spec.cwd,
	env,
	shell: true,
	detached: true,
	stdio: "ignore",
});
```

#### Why It Is Wrong
`spec.cmd` originates from model assessment output (`CodeAssessmentData.services.api.cmd`). It is spawned directly into the system shell (`shell: true`) with the host's complete `process.env` (which includes credentials, cloud keys, and API tokens). The only safeguard is `checkBashCommand`, which is a static denylist of 20 regular expressions. Denylists do not provide robust protection against shell injection (e.g. environment variable exfiltration via subshells, string interpolation, Python/Node inline scripts, or encoded commands).

#### Impact Scenario
If a repository contains prompt injection or if the assessment model emits an unexpected command containing subshell execution (e.g. `npm run dev; node -e "..."`), the command executes with host credentials outside the agent sandbox.

#### Concrete Actionable Fix
1. Parse `spec.cmd` into discrete executable and arguments (or validate against an allowlist of standard package manager scripts like `npm run ...`, `vite`, `cargo run`).
2. Remove sensitive credentials from the child environment, passing only necessary sanitized variables.

---

### FINDING-08: Data Race in `appendToKnowledge` During Parallel Review Stage
- **Severity:** High (P1)
- **Class:** risk (concurrency)
- **File & Line:** `src/render/knowledge.ts:45-62` (cross-ref: `src/stages/verify.ts:834, 850, 875`)

#### Code Snippet
In `src/render/knowledge.ts`:
```typescript
export function appendToKnowledge(specDir: string, stageId: string, control: Record<string, unknown> | null): void {
	if (!control) return;
	const path = knowledgePath(specDir);
	let knowledge: KnowledgeFile;
	try { knowledge = JSON.parse(readFileSync(path, "utf8")); } catch { knowledge = { stages: {} }; }
	knowledge.stages[stageId] = {
		timestamp: new Date().toISOString(),
		agent: String(control.agent ?? stageId),
		data: control,
	};
	try {
		const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, JSON.stringify(knowledge, null, 2) + "\n");
		renameSync(tmp, path);
	} catch { /* best-effort */ }
}
```

In `src/stages/verify.ts:810-890`:
```typescript
export const reviewStep = parallel([
	task({ id: "codeReview", ... renderAndWrite(..., "codeReview", control) }),
	task({ id: "adversarialReview", ... renderAndWrite(..., "adversarialReview", control) }),
	task({ id: "testsReview", ... renderAndWrite(..., "testsReview", control) }),
]);
```

#### Why It Is Wrong
`codeReview`, `adversarialReview`, and `testsReview` execute concurrently via `parallel(...)`. When they complete, each task calls `renderAndWrite`, which in turn calls `appendToKnowledge`. `appendToKnowledge` performs a synchronous `readFileSync`, updates its in-memory object, and renames a temporary file over `.knowledge.json`. Because multiple tasks interleave between reading and writing, the task that writes last overwrites `.knowledge.json` with a snapshot that lacks the stages written by earlier tasks.

#### Impact Scenario
Stage knowledge entries for `codeReview` or `adversarialReview` are intermittently missing from `.knowledge.json`. Subsequent stages relying on `knowledgeForAgent` fail to receive required review context.

#### Concrete Actionable Fix
Synchronize writes to `.knowledge.json` using an in-process promise queue or file-lock, or defer `appendToKnowledge` to the `join` handler of `reviewStep` where merged review state is finalized.

---

### FINDING-09: Document Number Collision in `specDocs` During Parallel Reviews
- **Severity:** Medium (P2)
- **Class:** risk (concurrency)
- **File & Line:** `src/prompts.ts:37-47` & `src/stages/verify.ts:834, 850, 875`

#### Code Snippet
In `src/prompts.ts`:
```typescript
function nextDocNumber(specDir: string, excludeSlugs: string[] = []): number {
	let count = 0;
	try {
		for (const entry of readdirSync(specDir)) {
			if (!/^\d{2}-.+/.test(entry)) continue;
			if (excludeSlugs.some((sg) => entry.endsWith(`-${sg}.md`))) continue;
			count++;
		}
	} catch { /* dir not readable yet — treat as empty */ }
	return count + 1;
}
```

#### Why It Is Wrong
In `src/stages/verify.ts:815`, three review tasks run concurrently in `parallel(...)`. Neither task pre-reserves its document filename prior to executing. When each task finishes, `renderAndWrite` calls `reserveStageDocs` -> `specDocs` -> `nextDocNumber`. If `codeReview` and `adversarialReview` finish at roughly the same time, both read `specDir` before the other's file has been written. Both calculate the identical next document index (e.g. `10`), resulting in files named `10-code-review.md` and `10-adversarial-review.md`.

#### Impact Scenario
Document ordering indices collide in `docs/specifications/NN-...`, violating the convention that each stage document receives a unique sequential index.

#### Concrete Actionable Fix
Pre-allocate or reserve document names at the start of `reviewStep` before spawning parallel tasks:
```typescript
reserveStageDocs(s.setup!, "codeReview");
reserveStageDocs(s.setup!, "adversarialReview");
reserveStageDocs(s.setup!, "testsReview");
```

---

### FINDING-10: TOCTOU File-Lock Race Condition in `acquireRunLock`
- **Severity:** Medium (P2)
- **Class:** risk (concurrency / TOCTOU)
- **File & Line:** `src/setup.ts:450-475`

#### Code Snippet
In `src/setup.ts`:
```typescript
try {
	fd = openSync(lockPath, "wx");
	writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
	closeSync(fd);
	fd = undefined;
	heldRunLockPath = lockPath;
	return;
} catch (err) {
	const code = (err as { code?: string }).code;
	if (code !== "EEXIST") throw err;
	const holder = readLockHolder(lockPath);
	if (holder && holder.pid !== process.pid && isPidAlive(holder.pid)) {
		throw new Error(`spec directory ${specDirectory} is locked by another super-dev run ...`);
	}
	rmSync(lockPath, { force: true });
}
```

#### Why It Is Wrong
`openSync(lockPath, "wx")` creates an empty file. If Process B attempts to acquire the lock after Process A's `openSync` but before Process A's `writeSync`, Process B receives `EEXIST` and calls `readLockHolder(lockPath)`. Because the file is currently empty, `JSON.parse("")` fails and `readLockHolder` returns `null`. Process B assumes the lock is invalid/stale, calls `rmSync(lockPath, { force: true })`, and proceeds to acquire the lock on attempt 2. Both processes then run simultaneously.

#### Impact Scenario
Two concurrent `super-dev` executions on the same track can simultaneously acquire the lock, clobbering worktree state, ledgers, and git branches.

#### Concrete Actionable Fix
If `readLockHolder` returns `null`, do not delete the lock immediately. Implement a short backoff (e.g. 50–100ms) and retry reading `readLockHolder` before treating the lock file as stale. Alternatively, write to a temporary file and atomically rename it via `linkSync` or `renameSync`.

---

### FINDING-11: `fingerprintFinding` Uses Unclassified `f.ownerStage` Instead of Target Owner
- **Severity:** Medium (P2)
- **Class:** real-bug
- **File & Line:** `src/replan/replan.ts:252-262` & `136-150`

#### Code Snippet
In `src/replan/replan.ts`:
```typescript
function fingerprintFinding(f: Record<string, unknown>): string {
	const detailHash = String(f.detail ?? "");
	let h = 5381;
	for (let i = 0; i < detailHash.length; i++) h = ((h << 5) + h) ^ detailHash.charCodeAt(i);
	const owner = String(f.ownerStage ?? "").toLowerCase().trim();
	return `${String(f.file ?? "")}|${String(f.severity ?? "")}|${String(f.title ?? "")}|${(h >>> 0).toString(36)}|${owner}`.toLowerCase().replace(/\s+/g, " ");
}
```

#### Why It Is Wrong
Reviewer findings often lack an explicit `ownerStage` field on the raw finding object; ownership is determined downstream by `classifyReplanOwnerDeterministic` or `classifyReplanOwner` (`decision.owner`).
1. In `triggerReplanForFindings`, `fingerprintFinding(finding)` hashes `owner = ""` because `finding.ownerStage` is undefined, even though `request.ownerStage` is set to `decision.owner`.
2. In `appendRouteBackRequests(specDir, owner, findings, ...)`, `owner` is explicitly passed as a function argument, but `fingerprintFinding` ignores it and reads `f.ownerStage`.

#### Impact Scenario
If two distinct findings have similar titles or details but are classified to different owners (e.g. one to `spec` and one to `design`), but neither had `ownerStage` set on the raw input finding, their fingerprints collide and one is dropped. Conversely, if a finding later gains an explicit `ownerStage`, its fingerprint changes, defeating deduplication.

#### Concrete Actionable Fix
Allow `fingerprintFinding` to accept an explicit owner fallback:
```typescript
function fingerprintFinding(f: Record<string, unknown>, targetOwner?: string): string {
	const detailHash = String(f.detail ?? "");
	let h = 5381;
	for (let i = 0; i < detailHash.length; i++) h = ((h << 5) + h) ^ detailHash.charCodeAt(i);
	const owner = String(targetOwner ?? f.ownerStage ?? "").toLowerCase().trim();
	return `${String(f.file ?? "")}|${String(f.severity ?? "")}|${String(f.title ?? "")}|${(h >>> 0).toString(36)}|${owner}`.toLowerCase().replace(/\s+/g, " ");
}
```

---

### FINDING-12: Path Traversal in `plan-feasibility.ts`
- **Severity:** Medium (P2)
- **Class:** risk (security / path traversal)
- **File & Line:** `src/stages/plan-feasibility.ts:147` & `290`

#### Code Snippet
In `src/stages/plan-feasibility.ts`:
```typescript
function identifierAvailableAtHead(worktreePath: string, writableFiles: string[], x: string): boolean {
	for (const rel of writableFiles) {
		try {
			const abs = join(worktreePath, norm(rel));
			if (!existsSync(abs)) continue;
			const text = readFileSync(abs, "utf8");
```
and `fileExportsIdentifier`:
```typescript
function fileExportsIdentifier(worktreePath: string, rel: string, x: string): boolean {
	try {
		const abs = join(worktreePath, norm(rel));
		if (!existsSync(abs)) return false;
		const text = readFileSync(abs, "utf8");
```

#### Why It Is Wrong
`norm(rel)` only replaces backslashes with slashes and strips leading `./`. It does not prevent directory traversal sequences (`../`) or absolute paths. `join(worktreePath, norm(rel))` can resolve outside `worktreePath`.

#### Impact Scenario
If a model-generated phase plan specifies deliverable files containing `../` traversal, `planFeasibilityFindings` reads arbitrary host files outside the worktree.

#### Concrete Actionable Fix
Use `resolveInsideCwd` or `isInsideOrSame` to guarantee that `abs` is strictly contained within `worktreePath`:
```typescript
const abs = resolve(worktreePath, norm(rel));
if (!abs.startsWith(resolve(worktreePath) + sep)) continue;
```

---

### FINDING-13: Safety Hooks in `src/safety.ts` Are Inactive in Production
- **Severity:** Medium (P2)
- **Class:** smell / security
- **File & Line:** `src/safety.ts:1-180` & `src/agents/register-agents.ts:180-245`

#### Code Snippet
In `src/safety.ts:144`:
```typescript
export function createSafetyExtensionFactory(): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.on("tool_call", async (event, ctx) => {
			if (toolName === "bash") {
				const r = checkBashCommand(String(input.command ?? ""));
				if (r.blocked) return { block: true, reason: ... };
			}
			...
		});
	};
}
```

#### Why It Is Wrong
`createSafetyExtensionFactory` is only imported in `bench/session-agent.ts`. In production (`register-agents.ts`), subagents do not load `createSafetyExtensionFactory` because subagents are spawned via `pi-subagents` delegation. Only `commit-guard` is loaded as a `subagentOnlyExtension`. Consequently, the bash denylist and secret-file protections defined in `safety.ts` are dormant during standard runs.

#### Impact Scenario
Developers relying on `safety.ts` to block commands like `rm -rf .` or protect `.env` files in production subagents are unprotected; agents can execute any command permitted by Pi's global tools.

#### Concrete Actionable Fix
Either wire `safety.ts` into subagent extension registrations alongside `commit-guard`, or document clearly that `safety.ts` is a legacy benchmark artifact and remove dead hooks.

---

### FINDING-14: `tolerantMatch` Evaluates Literal Patterns as Raw Regular Expressions
- **Severity:** Medium (P2)
- **Class:** real-bug / risk
- **File & Line:** `src/build-runner/gates.ts:1242-1249`

#### Code Snippet
In `src/build-runner/gates.ts`:
```typescript
export function tolerantMatch(pattern: string, text: string): boolean {
	const tryPattern = (p: string): boolean => {
		let source = p;
		let flags = "";
		if (source.startsWith("(?i)")) {
			source = source.slice(4);
			flags = "i";
		}
		let re: RegExp | null = null;
		try { re = new RegExp(source, flags); } catch { re = null; }
		if (re && re.test(text)) return true;
		if (text.includes(p)) return true;
		if (flags === "i" && text.toLowerCase().includes(source.toLowerCase())) return true;
		return false;
	};
```

#### Why It Is Wrong
When `pattern` is intended as a literal code string (e.g. `foo(bar)` or `obj.property`), `new RegExp(source, flags)` interprets regex metacharacters (`(`, `)`, `.`, `+`, `*`). For example, `foo(bar)` compiles to a regex matching `"foobar"`, which will falsely match text that does not contain the literal parentheses. In `requireNotContains`, matching `obj.property` against `obj-property` falsely fails the gate.

#### Impact Scenario
1. In `requireContains`, a phase deliverable checking for a function call `connect(db)` passes on `connectdb`.
2. In `requireNotContains`, a phase forbidding `a.b` is rejected if `a-b` exists in the file.
3. Complex agent patterns can cause ReDoS during `re.test(text)`.

#### Concrete Actionable Fix
Differentiate literal pattern matching from regex matching. If `pattern` contains regex constructs (e.g. starts with `(?i)` or is explicitly delimited), evaluate as regex; otherwise, evaluate exact substring containment before attempting regex parsing.

---

### FINDING-15: Platform Portability Issue in `buildToolIndexFromTools` on Windows
- **Severity:** Medium (P2)
- **Class:** risk (platform portability)
- **File & Line:** `src/agents/agent-runtime.ts:347-360`

#### Code Snippet
In `src/agents/agent-runtime.ts`:
```typescript
export function buildToolIndexFromTools(
	tools: Array<{ name: string; sourceInfo?: { source?: string; path?: string } }>,
): Map<string, string[]> {
	const re = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/;
	const toolIndex = new Map<string, string[]>();
	for (const t of tools) {
		const source = t.sourceInfo?.source ?? "";
		const sourcePath = t.sourceInfo?.path ?? "";
		const pkg = source.startsWith("npm:") ? source.slice(4) : (re.exec(sourcePath)?.[1] ?? "");
		if (!pkg || pkg === "pi-coding-agent" || pkg.endsWith("/pi-coding-agent")) continue;
		const list = toolIndex.get(pkg);
		if (list) list.push(t.name);
		else toolIndex.set(pkg, [t.name]);
	}
	return toolIndex;
}
```

#### Why It Is Wrong
On Windows, file paths use backslashes (`\`). When `sourcePath` contains `node_modules\@scope\my-ext\index.js`, the capture group `((?:@[^\\/]+[\\/])?[^\\/]+)` captures `@scope\my-ext` with a backslash. `toolIndex` stores the key as `"@scope\\my-ext"`. Downstream lookups via `extensionPackagesForAgent` query using normalized package names with forward slashes (`"@scope/my-ext"`), causing tool resolution to fail.

#### Impact Scenario
On Windows workstations, tools from scoped npm extension packages (e.g. `@earendil-works/...`) are not merged into delegated agent tool allowlists.

#### Concrete Actionable Fix
Normalize `pkg` to use forward slashes:
```typescript
const rawPkg = source.startsWith("npm:") ? source.slice(4) : (re.exec(sourcePath)?.[1] ?? "");
const pkg = rawPkg.replace(/\\/g, "/");
```

---

### FINDING-16: Background `runPostMortem` Promise Unawaited and Untracked in Lifecycle
- **Severity:** Low (P3)
- **Class:** smell / async
- **File & Line:** `src/extension.ts:1047-1065`

#### Code Snippet
In `src/extension.ts`:
```typescript
void runPostMortem({
	events: bus,
	runId: frame.runId,
	status: summary.status,
	metricsRow: frame,
	artifactPaths: {
		runLog: logPath,
		eventsJsonl: summary.specDirectory ? `${summary.specDirectory}/events.jsonl` : undefined,
		specDir: summary.specDirectory || undefined,
	},
}).then((out) => {
	auditAppend(out.draftPath
		? { stage: "post-mortem", control: { event: "finding-draft", path: out.draftPath } }
		: { stage: "post-mortem", error: out.error ?? "no draft" }, runDir);
}).catch(() => { /* best-effort (P5) */ });
```

#### Why It Is Wrong
While `runReflectionAsync` is tracked via `noteInFlightReflection` and reported during `session_shutdown`, `runPostMortem` is launched as a detached background promise without registration. If Pi shuts down or reloads during post-mortem analysis, the child agent is abruptly severed without logging or cleanup.

#### Impact Scenario
Process terminations during post-mortem generation leave orphaned processes or partially written finding drafts in `docs/findings/inbox/`.

#### Concrete Actionable Fix
Track `runPostMortem` promises in `pendingReflections` or a dedicated in-flight registry and handle in `session_shutdown`.

---

### FINDING-17: Typo in Exported API Function Name `attributQuarantinedViolations`
- **Severity:** Low (P3)
- **Class:** smell (naming)
- **File & Line:** `src/stages/implementation.ts:1363`

#### Code Snippet
In `src/stages/implementation.ts`:
```typescript
export function attributQuarantinedViolations(
	worktreePath: string,
	payload: BoundaryQuarantinePayload | null | undefined,
	implControl: unknown,
	testFiles: string[],
	log: (line: string) => void,
): void {
```

#### Why It Is Wrong
The function name is misspelled as `attributQuarantinedViolations` (missing 'e' in "attribute").

#### Impact Scenario
Degrades code readability and developer discovery across public module exports.

#### Concrete Actionable Fix
Rename to `attributeQuarantinedViolations` and alias the deprecated spelling for backward compatibility.

---

### FINDING-18: Missing Provable Loop Bound Comments in Stage 10 Loops (P8 Violation)
- **Severity:** Low (P3)
- **Class:** smell (methodology P8)
- **File & Line:** `src/stages/verify.ts:1436` & `1760`

#### Code Snippet
In `src/stages/verify.ts:1436`:
```typescript
for (let attempt = 1; ctx.budget.check(); attempt++) {
	...
	continue;
}
```

#### Why It Is Wrong
Engineering Principle P8 states:
> "Every retry/continue path must provably terminate: signature history, hard ceiling, or budget — with a test that provokes the bound. `continue` inside a loop requires a comment naming its bound; a test that reaches the bound."
Several `continue` branches in `src/stages/verify.ts` rely on implicit bounds without naming the specific termination condition.

#### Impact Scenario
Difficult to formally prove termination or verify that no infinite loop regression is introduced during maintenance.

#### Concrete Actionable Fix
Add explicit comments at every `continue` site in `verify.ts` identifying the governing termination bound (e.g. `// Bound: ctx.budget.check() and VERIFICATION_STAGNATION_CHANGED_FIX_ATTEMPT_FLOOR`).

---

## 5. Per-Module Assessment

### 5.1 Engine Core (`implementation.ts`, `judge.ts`, `gates.ts`, `fault-classification.ts`, `plan-feasibility.ts`)
- **Strengths:** 
  - `src/stages/implementation.ts` represents a sophisticated, battle-hardened implementation loop. Dirt provenance partitioning (`runStartDirt`) prevents foreign repository noise from masquerading as product regressions.
  - The parallel RED review with post-implementation join (`redReviewInFlight`) significantly reduces wall-clock latency while preserving fail-closed discipline.
  - `src/fault-classification.ts` is pure, fully synchronous, and impeccably unit-tested.
- **Weaknesses:**
  - `src/stages/implementation.ts` has grown to over 4,000 lines, making comprehension and local reasoning challenging (SRP smell).
  - Containment checks in `judge.ts` have holes for absolute paths (FINDING-03).
  - Clause checking in `gates.ts` drifts between `deliverablesAlreadyMet` and `runDeliverableCheck` (FINDING-04).

### 5.2 Replan Circuit (`src/replan/`)
- **Strengths:**
  - Clear two-tier design: pure deterministic rules in `owners.ts` followed by strong-model residue classification in `lead.ts`.
  - Thorough invalidation protocol (`invalidateResumeCache`) utilizing artifact revision counters (`artifact-revisions.json`).
- **Weaknesses:**
  - Human request persistence bug when `newRequests.length === 0` (FINDING-06).
  - Fingerprint generation does not account for classified owners (FINDING-11).

### 5.3 Control Schemas & Parser Surface (`src/render/schemas.ts`, `src/control.ts`)
- **Strengths:**
  - Centralized TypeBox schema definitions enabling compile-time and runtime validation.
  - `repairUnescapedQuotes` successfully handles common JSON model formatting quirks.
- **Weaknesses:**
  - Critical divergence between control schemas and actual prompt/agent contracts (`JudgeControlData` and `FileClassifyControlData`, FINDINGS 01 & 02).
  - `findLastJsonObject` extracts innermost instead of outermost objects (FINDING-05).

### 5.4 Agent Runtime & Wiring (`src/agents/`, `src/extension.ts`, `src/harness-paths.ts`)
- **Strengths:**
  - Canonical basename registry in `src/harness-paths.ts` cleanly solves previous four-way set drift.
  - Clean separation between capability agents and mechanical classifiers.
  - Excellent telemetry collection in `tool-usage.jsonl` and `usage-calls.jsonl`.
- **Weaknesses:**
  - Legacy safety hooks in `safety.ts` are inactive in production (FINDING-13).
  - Missing Windows path normalization in package tool indexing (FINDING-15).

---

## 6. Repository Methodology (P1–P10) Compliance Notes

- **P1 — The LLM is an untrusted input source:**
  - *Status:* **Compliant in core gates, non-compliant in lifecycle service bringup.**
  - Deterministic oracles (build-runner, deliverable checks) govern code acceptance rather than agent claims. However, `lifecycle.ts:129` spawns model-generated commands with `shell: true` (FINDING-07).
- **P2 — Enumerate the input grammar; never sample it:**
  - *Status:* **Partial Violation.**
  - `PhaseDeliverables` supports 5 clauses, but `deliverablesAlreadyMet` only checks 4 (FINDING-04).
- **P3 — Concurrency changes require failure-path enumeration:**
  - *Status:* **Minor Violations.**
  - Parallel reviewers in `reviewStep` race on `.knowledge.json` (FINDING-08) and doc numbers (FINDING-09).
- **P4 — A prompt is advisory; enforcement is mechanical:**
  - *Status:* **Compliant.**
  - Source boundaries and commit guards use mechanical hooks rather than relying on prompt compliance.
- **P5 — Fail-closed for work evidence; fail-open for judge failures:**
  - *Status:* **Compliant.**
  - Checker failures (reviewer timeouts, boundary throws) fail open to preserve valid GREEN work, while invalid work evidence fails closed.
- **P6 — Cross-module contracts get cross-checked, not remembered:**
  - *Status:* **Major Violations.**
  - `JudgeControlData` and `FileClassifyControlData` drift directly from their consumers (FINDINGS 01 & 02). Dynamic AST cross-check tests are missing for these schemas.
- **P7 — Fix the class, not the instance:**
  - *Status:* **Compliant.**
  - The repository demonstrates excellent adherence to class-level fixes (e.g. `HARNESS_FILE_ROLES` in `harness-paths.ts`).
- **P8 — Every loop and every budget has a proven bound:**
  - *Status:* **Mostly Compliant.**
  - All retry loops have hard ceilings or budget checks, though some Stage 10 `continue` branches lack explicit bound annotations (FINDING-18).
- **P9 — Machine-independent, environment-realist tests:**
  - *Status:* **Minor Violation.**
  - Tool indexing fails on Windows due to unescaped backslashes in scoped packages (FINDING-15).
- **P10 — Evidence trails must be honest and located:**
  - *Status:* **Compliant.**
  - Logging and audit trails across `runlog.ts` and `change-tracker.jsonl` maintain high location accuracy and honest status reporting.

---

## 7. Top-10 Recommended Fixes (Risk-Reduction-per-Effort)

1. **Fix `JudgeControlData` schema to accept `{file, quote}` objects (FINDING-01):**
   - *Effort:* Low (5 LoC in `src/render/schemas.ts`).
   - *Impact:* Critical. Unblocks the LLM Judge escape valve across all no-progress/stagnation wiring points.
2. **Fix `FileClassifyControlData` optionality (FINDING-02):**
   - *Effort:* Low (5 LoC in `src/render/schemas.ts`).
   - *Impact:* Critical. Prevents schema validation failures during RED boundary classification.
3. **Fix `findLastJsonObject` brace scan logic (FINDING-05):**
   - *Effort:* Low (15 LoC in `src/control.ts`).
   - *Impact:* High. Prevents unparsed control fallbacks from rejecting valid JSON with nested objects.
4. **Persist human replan requests when `newRequests.length === 0` (FINDING-06):**
   - *Effort:* Low (4 LoC in `src/replan/replan.ts`).
   - *Impact:* High. Prevents silent loss of human-owned findings during replan routing.
5. **Add `requireTests` to `deliverablesAlreadyMet` and `reverifyPartialPhases` (FINDING-04):**
   - *Effort:* Medium (20 LoC across `gates.ts` and `implementation.ts`).
   - *Impact:* High. Restores complete deliverable contract coverage and prevents false greens.
6. **Harden `verifyJudgeEvidence` containment and `boundedRead` (FINDING-03):**
   - *Effort:* Medium (25 LoC in `src/stages/judge.ts`).
   - *Impact:* High. Eliminates process hang/OOM risks on device files and prevents host path disclosure.
7. **Synchronize or sequence `appendToKnowledge` writes (FINDING-08):**
   - *Effort:* Low (15 LoC in `src/render/knowledge.ts` or `src/stages/verify.ts`).
   - *Impact:* High. Prevents data loss in `.knowledge.json` during parallel review execution.
8. **Sanitize or constrain `lifecycle.ts` service execution (FINDING-07):**
   - *Effort:* Medium (30 LoC in `src/stages/lifecycle.ts`).
   - *Impact:* High. Prevents arbitrary shell command execution with host credentials.
9. **Pre-reserve review document numbers before parallel execution (FINDING-09):**
   - *Effort:* Low (10 LoC in `src/stages/verify.ts`).
   - *Impact:* Medium. Prevents document number collisions in the spec directory.
10. **Add backoff retry to `acquireRunLock` empty file check (FINDING-10):**
    - *Effort:* Low (10 LoC in `src/setup.ts`).
    - *Impact:* Medium. Prevents TOCTOU lock stealing during concurrent run startup.
