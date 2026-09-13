# Subprocess-Backend Spawn Resilience — RPC Corrective Retry, Structured Output, Task Delivery, Skills (v0.2.10)

Status: implemented (this commit — v0.2.10)

## 1. Problem

The subprocess backend (`src/pi-spawn.ts`) is the outlier agent path: every
mechanism the session backend got right is missing there, and every incident
class observed this week that is *backend-attributable* traces to it.

### Evidence table

| Incident | Mechanism | Backend |
|---|---|---|
| dogfood track 29 (run 2026-08-18T01-16-12-919Z): spec writer ended 5 consecutive rounds with narration ("Composing the complete structured specification now.") — `control=null`, ROUND CAP 8 death | Control delivery is a *text etiquette* (`<control>` block in final message); nothing structural stops "announce then stop" | subprocess |
| pi-omisis run 2026-08-18T00-28-14-819Z Phase 2: 3 × uniform ~29s `control=no` narration loops; Phase 2 try 1 did 4m32s of real work, wrote the test file, then ended without `structured_output`; corrective re-prompt ("please emit the control JSON") to a FRESH process re-entered the same narration loop — the agent had no memory of the work it had done | Corrective retry = fresh `pi` process (`spawnAgent`, the `buildSubprocessCorrectivePrompt` respawn); a fresh agent cannot "finish" work it never saw | subprocess |
| The same run's false "the TDD agent returned no test files" cascade: the good on-disk test file was later deleted by RED cleanup because control said nothing | Same root — `control` absent while real work existed on disk | subprocess |
| Spawn log line: `Task: [prompt 28444 chars]` embedded in argv | Task text rides argv: visible in `ps`/audit logs, risks EDR pre-exec argv scanning (zero-activity SIGKILL class documented in pi-subagents) and ARG_MAX edges | subprocess |
| tdd/react/threejs/cloudflare… skills unusable by implementer/tdd-guide when `SUPER_DEV_BACKEND=subprocess` | `--no-skills` is unconditional in `buildSpawnArgs`; the session backend inherits host skills — a capability asymmetry between backends | subprocess |

Note the session backend already does the corrective turn right — one
corrective turn **in the same session** (`src/session-agent.ts`, the
corrective re-prompt after a missing-control run) — and already delivers
control via a schema-declared `structured_output` **tool**
(`structuredOutputTool`, `src/session-agent.ts:297`). The subprocess backend
never got either mechanism.

## 2. Research grounding

Two evidence sources: (a) live probes against `pi --mode rpc` on this machine
(this session), and (b) a full read of the installed `pi-subagents` package's
spawn machinery (`prompts/review-loop.md`, `src/runs/shared/pi-args.ts`,
`pi-spawn.ts`, `subagent-prompt-runtime.ts`, `structured-output.ts`,
`subagent-startup-retry.ts`, `src/runs/foreground/execution.ts`).

### 2.1 Probes (verified on this machine, pi 0.84.x)

1. **stdin without positional args works** in `--mode json -p`: piping the task
   to stdin is accepted, so argv is not the only task channel even in one-shot
   mode.
2. **RPC same-process memory retention**: `pi --mode rpc` driven over stdin
   NDJSON — turn 1 "remember FALCON-3319", turn 2 (a second `prompt` event)
   recalled it verbatim. A second turn starts from the agent's own completed
   reading. This is the pi-native primitive the corrective retry was always
   missing.
3. **`follow_up` event type**: accepted (`response success:true`,
   `queue_update.followUp`), lands as the next in-session turn — same memory
   semantics as `prompt`.
4. **`abort` event**: stops the in-flight turn; process stays alive (we own
   the kill, as today via the SIGTERM→SIGKILL ladder).
5. **`--mode rpc` + `--no-session` compose**: in-memory context, no session
   file on disk, memory retained across turns. (Probes ran exactly this
   combination.)
6. **pi CLI has no native schema flag** (`--help`, dist grep): structured
   output for a child process can only come from a runtime extension loaded
   via `-e` — exactly how pi-subagents does it, and exactly how this repo
   already loads `pi-web-access`/`pi-mcp-adapter`/`pi-browser-cdp-extension`
   (`extensionsForAgent`).

### 2.2 pi-subagents mechanisms read in full

- **Task via `@file`** (`pi-args.ts`, `TASK_ARG_LIMIT = 8000`): long tasks are
  written to a 0600 temp file and argv carries `@<path>`; motivation documented
  as EDR pre-execution argv scanning killing children with long
  natural-language argv. Fallback delivery remains `Task: <text>` in argv.
- **structured_output as a tool** (`subagent-prompt-runtime.ts` +
  `structured-output.ts`): the parent writes `schema.json` and pre-agrees an
  `output.json` path; a runtime extension — always injected via `-e`, immune to
  `--no-extensions` — registers a `structured_output` tool whose parameters
  wrap the real schema under `{value: <schema>}` (with a recursive `$ref`
  rewriter from `#/…` to `#/properties/value/…`), validates with the same
  typebox compile as the host, writes the capture file (0600), and returns
  `terminate: true` — the tool call *is* the step terminator, making
  "announce-then-keep-talking" structurally impossible. `before_agent_start`
  prepends a hard instruction ("final action must be the structured_output
  call; prose-only completion fails the step") plus child-boundary instructions
  ("never print pseudo-tool-call syntax as text"). Parent side: stale
  `output.json` is unlinked before spawn; after exit-0 the NDJSON stream must
  contain a `structured_output` tool call, the file is read and **re-validated**
  (double validation), and a missing call is a deterministic failure
  (`MISSING_STRUCTURED_OUTPUT_CALL_ERROR`) — not a silent pass.
- **Zero-activity startup retry** (`subagent-startup-retry.ts`): only
  exit≠0 + no messages/tools/usage/output + ≤2000ms + SIGKILL-or-empty-error
  classifies as retryable (fail-closed); bounded [250/750/1500]ms; retry
  switches task delivery to file mode. (Adopted as backlog here — see
  non-goals; the @file/stdin channels remove the trigger.)
- **`/review-loop` prompt** (orchestration layer, not spawn layer): parent as
  loop controller, fresh-context reviewers per round, feedback synthesized and
  triaged by the parent before any fix worker, default 3-round cap, explicit
  stop conditions. Our convergence loops already embody this shape; noted for
  reference, no change in this doc.

## 3. Fixes

Seven identified gaps consolidate into four work items. Gap numbering follows
the session analysis (S1–S3 original ranked gaps; S4–S7 added during
verification/research):

| Gap | Incident driver | Work item |
|---|---|---|
| S1 corrective retry respawns a fresh, amnesiac process | pi-omisis Phase 2, track 29 | W1 |
| S2 task text embedded in argv (28444 chars observed) | spawn log; EDR class | W2 |
| S3 control delivery is text-only etiquette; announce-without-control has no structural prevention | track 29 (5×), pi-omisis (3×) | W3 |
| S4 RPC `follow_up` same-session corrective (verified primitive) | probe 2/3 | W1 |
| S5 skills disabled for all subprocess agents (user directive: every agent should be able to load skills) | capability asymmetry | W4 |
| S6 `@file` task delivery for long prompts (pi-subagents pattern) | EDR/argv risk | W2 |
| S7 structured_output tool-ization for the subprocess backend | deep-dive mechanism | W3 |

### W1 — RPC driver: same-process corrective retry (`--mode rpc`)

`spawnAgent` gains an RPC execution path (default ON, kill-switch
`SUPER_DEV_NO_RPC_SPAWN=1` falls back to today's json one-shot behavior):

- argv: `pi --mode rpc --no-session --no-skills? … --system-prompt <file>`
  — **no positional task**; the task rides the first stdin
  `{"id","type":"prompt","message":"Task: …"}` event. This alone takes the
  task text out of argv for the RPC path (S2 covered here; W2 covers only the
  json fallback).
- completion detection moves from "process close" to protocol events: wait for
  the id-matched `{"type":"response"}` plus `agent_settled`; final assistant
  text still comes from the last assistant `message_end` (same parser reuse).
- corrective retry becomes a **`follow_up` event in the same process**: the
  agent sees "you ended without the required structured_output/control — call
  it now with the complete object", starting from its own completed context.
  Exactly one corrective turn (parity with the session backend), then fail with
  the missing-keys error.
- total wall-clock budget unchanged (timeoutMs spans prompt + follow_up);
  abort and the SIGTERM→SIGKILL ladder unchanged (we still own the kill; RPC
  `abort` event is sent first as a courtesy stop).

### W2 — `@file` task delivery (json fallback path)

In the non-RPC fallback (`SUPER_DEV_NO_RPC_SPAWN=1` or future degradation),
`buildSpawnArgs` writes the task to a 0600 temp file and passes `@<path>` when
`Task:` text exceeds `TASK_ARG_LIMIT = 8000` chars (constant exported,
pi-subagents value). Short tasks keep argv delivery (audit-visible). Temp file
lives in the existing `mkdtemp` dir and is cleaned by the existing `finally`.

### W3 — structured_output tool for the subprocess backend

Same mechanism pi-subagents proved, adapted to our contracts:

- New repo file `src/subprocess-structured-output.ts` — a pi runtime extension
  (loaded by child pi via `-e`; path derived from `import.meta.url` so it works
  both from the repo and from the installed extension layout). Behavior:
  - reads `SUPER_DEV_SO_SCHEMA` / `SUPER_DEV_SO_CAPTURE` env paths (both must
    be present, else no-op — the extension is inert without them);
  - registers `structured_output` with parameters `{value: <schema>}` (with
    the recursive local-`$ref` rewrite to `#/properties/value/…`);
  - validates via typebox compile (resolved the same way our render schemas
    already resolve typebox — no new dependency), invalid → thrown error with
    up to 8 `instancePath: message` items so the model can self-correct
    in-session;
  - valid → writes capture JSON (0600) and returns `terminate: true`;
  - `before_agent_start` prepends the hard final-action instruction and the
    "never print pseudo-tool-call syntax as text" boundary line.
- Parent (`pi-spawn.ts`): when `controlKeys` is non-empty, build the control
  schema (extract/reuse the session backend's keys-declared-Optional builder
  into a shared module so both backends emit the identical contract), write
  `schema.json` + pre-agree `output.json` in the temp dir, export the two env
  vars to the child, unlink any stale `output.json` before spawn, and add the
  extension path to the `-e` list. The tool is visible to the child under our
  existing `--exclude-tools` blacklist (extension-registered tools don't need
  `--tools` whitelisting; blacklist still removes super_dev/edit/write).
- Result merge: `control = toolCapture ?? extractControl(text)` — the
  `<control>` text contract is retained as **fallback** (backward compat for
  any path that still emits it), with the capture re-validated parent-side
  (double validation, mirroring pi-subagents). After the run, the spawn log
  records `structured_output: captured|text-fallback|absent` plus a capture
  size/sha256 prefix for auditability.

### W4 — skills enabled for subprocess agents

`buildSpawnArgs` drops `--no-skills` by default (user directive: skills are a
capability, and the session backend always had them — this restores parity).
Kill-switch `SUPER_DEV_NO_SKILLS=1` restores today's isolation for
debugging/CI. `--no-extensions`, `--no-context-files`,
`--no-prompt-templates`, `--no-session` isolation flags are unchanged.

## 4. Non-goals

- No migration to `--tools` positive whitelisting (blacklist semantics kept;
  extension tools are visible under it).
- No adoption of pi-subagents as a dependency; its patterns are reimplemented
  in our spawner.
- No EDR zero-activity startup-retry loop (backlog: stdin/@file delivery
  removes the documented trigger; revisit if a zero-activity SIGKILL is ever
  observed here).
- No `--session <file>` persistence across child process death (backlog: RPC
  keeps one process alive; a session file would add durability for
  timeout-killed children).
- No steering inbox / watchdog / permission-gate ports from
  `subagent-prompt-runtime.ts` (our run model doesn't need mid-run steering of
  subprocess agents yet).
- No orchestration changes from the `/review-loop` prompt (our convergence
  loops already implement the parent-controlled review/fix shape; round caps
  and reviewer discipline are governed by the v0.1.98–v0.2.9 machinery).
- Session backend unchanged (it already has both mechanisms).

## 5. Verification plan

RED-first, per repo discipline (stash `src/`, new tests must fail on pre-fix
code; negative controls must pass on both trees):

1. `tests/subprocess-structured-output.test.ts` — the runtime extension against
   a fake `pi` API object: parameters wrap `{value}`; `$ref` rewrite; valid →
   file written + `terminate:true`; invalid → thrown error string; env-absent →
   no tool registered. Plus the extracted shared schema builder: identical
   output to the session backend's builder.
2. `tests/rpc-driver.test.ts` — an `RpcDriver` fed synthetic NDJSON lines:
   prompt → response+settled → capture; missing control → exactly one
   `follow_up` written to stdin → second turn capture; follow_up → still
   missing → deterministic error; timeout spans both turns; abort sends the
   RPC abort then ladder. (Driver extracted so the event logic is testable
   without spawning real pi.)
3. `tests/pi-spawn-v0210.test.ts` — argv pins: no `--no-skills` by default;
   `SUPER_DEV_NO_SKILLS=1` restores it; `@<path>` delivery only when task >
   8000 chars in json mode; `-e` gains the structured-output runtime when
   controlKeys non-empty; env handoff vars exported; RPC mode argv has no
   positional task. (`tests/pi-spawn.test.ts` and
   `tests/pi-spawn-control-retry.test.ts` pins updated in-pass: skills
   default-on, and the control-retry suite pinned to the json fallback path
   it always tested.)
4. Real-pi end-to-end round trip (the FALCON-probe pattern: prompt → capture →
   follow_up memory check) behind `SUPER_DEV_SPAWN_E2E=1` (default-skipped in
   CI, same gating convention as the benchmark harness).
5. Full gates: `npx tsc --noEmit` clean; `npx vitest run` green.

## 6. Implementation order

(unchanged — executed W3 → W1 → W2 → W4.)

## 7. Implementation deviations (probe-verified)

Three plan assumptions were corrected by live-probe evidence during
implementation:

1. **The corrective rides a `prompt` event, not `follow_up`.** A live
   `follow_up` sent after `agent_settled` is ACKED (`response success`,
   `queue_update`) but the turn NEVER RUNS (286s of silence in the E2E
   probe); a second `prompt` event on the SAME process reliably starts the
   next in-memory turn (turn-2 recalled the turn-1 secret verbatim).
   Same session, same memory — only the event type differs from the W1
   wording above.
2. **`response` is an ack, not a completion signal.** It is emitted even
   BEFORE `agent_start`; the turn-completion signal is `agent_settled`.
   `runPiRpc` therefore requires BOTH the id-matched `response` and
   `agent_settled`, order-independent (probe4 observed the ack arriving
   AFTER settled).
3. **`resolvePiBinary` gained package-root validation** (the pi-subagents
   defense): under vitest, `process.argv[1]` is vitest's own `.mjs` entry,
   and the unvalidated ladder spawned `node vitest.mjs --mode rpc …` → exit 1.
   The resolver now verifies a candidate entry belongs to a real
   `@earendil-works/pi-coding-agent` package root before accepting it.
4. **In-tool validation is STRUCTURAL, not typebox.** The child-side
   extension validates with a zero-import structural checker (type/properties/
   required/additionalProperties walk), NOT typebox compile — the plan's §3 W3
   "validates via typebox compile" wording was corrected during
   implementation. Rationale: the extension runs inside the child pi process
   and must never depend on resolving the parent's typebox package root; the
   parent-side re-validation (the authoritative completeness gate) covers the
   remainder. The shared schema builder was likewise not extracted —
   `controlSchemaJson` in pi-spawn.ts is a local mirror of session-agent's
   `controlSchema`, pinned semantically by a parity test.

1. W3 (extension + env handoff + capture merge + shared schema builder) —
   independent, works in json mode immediately.
2. W1 (RpcDriver + spawnAgent RPC path + follow_up corrective) — uses W3's
   capture as the corrective trigger.
3. W2 (`@file` in the json fallback path).
4. W4 (skills default-on + kill-switch).
5. Release: version 0.2.9 → 0.2.10 across `src/version.ts`, `package.json`,
   `package-lock.json`, `tests/version.test.ts`; `docs/ARCHITECTURE.md`
   regeneration; CHANGELOG Unreleased bullet; dual code-reviewer +
   adversarial-reviewer systematic review; commit under the
   generating-commit-messages skill.

## 8. Review outcome

Dual systematic review (code-reviewer + adversarial-reviewer) on the
uncommitted change set. Code-reviewer verdict: CHANGES REQUESTED — 9 findings
(F-1 high, F-2..F-5 medium, F-6/F-7 low, F-8/F-9 info), all remediated:

- **F-1 (high)** stale-capture masking: the structured_output capture file is
  now unlinked immediately before EVERY corrective attempt (json respawn and
  RPC turn 2), so a partial first-turn capture can never mask the corrective's
  text-channel recovery; pinned RED-first by a json-path spawnAgent regression
  and a runPiRpc-level test (both fail on pre-fix code).
- **F-2** the DEFAULT rpc path now logs the `structured_output:
  captured|text-fallback|absent` audit line (previously json-fallback only).
- **F-3** CHANGELOG/plan wording corrected to structural validation; the
  parity pin added (controlSchemaJson ≡ session controlSchema semantics).
- **F-4** new hermetic `tests/pi-spawn-rpc-run.test.ts` (fake child, scripted
  NDJSON): corrective-once, remaining-budget skip, turn-1-error skip,
  abort→abort-event+SIGTERM, old-pi quick-exit error + hint.
- **F-5** the before_agent_start idempotency check now keys on the distinctive
  instruction sentinel (not the bare tool name), so role prompts that mention
  `structured_output` in their own prose still receive the hard instructions.
- **F-6** a zero-event non-zero quick exit logs the explicit
  `SUPER_DEV_NO_RPC_SPAWN=1` hint naming the pi@0.82.1 peer floor.
- **F-7** the spawn-error path disposes the driver (no dangling turn timer).
- **F-8** unused `now` dep dropped from RpcDriverDeps; follow_up's test-only
  status documented.
- **F-9** CHANGELOG test counts corrected (15 unit + 2 gated E2E).

### Adversarial-reviewer verdict (post-remediation tree): APPROVED WITH COMMENTS

Reviewed against the settled working tree and independently re-verified:
tsc strict-clean, full suite 160 files / 2554 passed + 2 skipped, both real-pi
E2E probes live (RPC round trip 7.9s, same-session corrective 18.7s), an
independent live W3 probe (tool fired, 0600 capture, terminate:true), pi
0.82.1 peer floor verifiably supports --mode rpc, and the follow_up / ack
deviations corroborated against pi's rpc-mode source. Findings and
dispositions:

- **adv-F-1 (low)** the `import.meta.resolve` resolver rung never resolves in
  plain Node/vitest (package.json not exported) — documented in-code as
  best-effort (the validated argv[1] and PATH rungs are load-bearing).
- **adv-F-2 (low)** no automatic degrade to json when a pre-floor host pi
  lacks rpc mode — the F-6 zero-event hint names the escape hatch; auto-degrade
  recorded as follow-up backlog, not fixed this cycle.
- **adv-F-3 (info)** review-target instability (remediation landed mid-review)
  — accepted; final gates re-run on the settled tree before commit.
- **adv-F-4 (info)** the CHANGELOG RED-first count was reworded to name the
  recipe and treat the count as suite-scoped.
- **adv-F-5 (info)** cosmetic residue fixed (unlink-block indentation, env
  identity ternary collapsed).
