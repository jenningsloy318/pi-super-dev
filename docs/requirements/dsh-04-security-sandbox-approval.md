# dsh-04 — Security: Sandbox Ladder, Approval Seam, Permissions, Credentials, and Defensive Engineering

Source repo (read-only): `docs/references/deepseek-harness` (github.com/deepseek-ai/deepseek-harness, MIT). All paths below relative to repo root. Companion reports: dsh-01 (architecture), dsh-02 (Cordis paper), dsh-03 (lifecycle), dsh-05 (ecosystem), dsh-06 (process), dsh-07 (Orange Book field data), dsh-08 (lessons for pi-super-dev).

---

## 1. Overview: the security posture in one view

dsh's security model is not one mechanism but a set of **composed capabilities, each fail-closed at its own seam**:

- **Sandbox** (`ctx.sandbox` + `ctx.sandboxPolicy`): a per-platform **rung ladder** of native confinement runners that wraps subprocess argv; file-effects-only vocabulary (`read-only` / `workspace-write` / `danger-full-access`); honest `full`/`partial` enforcement reporting; `SANDBOX_UNAVAILABLE` fail-closed on any gap — "silent unconfined passthrough is never legal for a confined policy" (`docs/subsystems/sandbox.md`, Provider section).
- **Approval** (`ctx.approval`): a closed-outcome one-shot permission question (`allowed-once | rejected | cancelled | unavailable`) routed through a waterfall of answerers; every ask/decision pair is appended to the session log as an audit pair; missing/throwing/non-conforming answerers degrade to `unavailable`, and callers deny on it (`docs/subsystems/approval.md`).
- **Permission presets** (`ctx.permissionPresets`): a pure UI bundling of the two independent enforcement knobs (sandbox mode + approval policy) into named presets; it owns **no enforcement** — it writes through each knob's canonical setter (`docs/subsystems/permission-presets.md`).
- **Credentials** (`ctx.credentials`): configuration carries only *references* (env-var names); providers own values; consumers **re-resolve per operation** (rotation without restart); one seam-wide rule: "an empty stored value is absent everywhere" (`docs/subsystems/credentials.md`).
- **Execution-world sharing**: fs and subprocess backends share one world, so "pointing them at a remote sandbox moves Bash, PTY, and LSP with them" (`docs/architecture.md`, Capability seams) — and the in-process fs fence derives its writable roots from the *same* function as the Seatbelt profile so "the two families never confine to different roots" (`packages/fs/fs-sandbox/README.md`).
- **Defensive engineering**: `docs/defensive-patterns.md` codifies seven hard-won bug-class rules, each traceable to a shipped or nearly-shipped defect (two documented in `docs/postmortem/0002-*` and `0004-*`).

A load-bearing honesty rule runs through everything: **capabilities describe only what they actually govern.** `SandboxMode` claims file effects only ("Network and process visibility are outside this vocabulary" — sandbox.md); the Windows rung's Everyone/hard-link gaps are reported as `partial`, "never promoted to the full promise" (`.agents/notes/implemented/feature/2026-07-06-sandbox.md`, Consequences); permission controls "cannot mount, unmount, or confine the filesystem stack" at runtime (postmortem 0002, Lessons).

---

## 2. The sandbox seam and the rung ladder

### 2.1 Vocabulary: modes, enforcement, per-call policy

```ts
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
type SandboxEnforcement = 'full' | 'partial'
interface SandboxExecutionPolicy { mode: SandboxMode; workspaceRoot: string; sessionId?: SessionId }
interface SandboxPolicy extends SandboxExecutionPolicy { mode: ConfinedSandboxMode }
```
(`docs/subsystems/sandbox.md`, Modes and enforcement / Per-call policy.)

Key design points:

- **Policy rides each CALL, not the provider**: "two consumers may confine under different policies at the same instant (bash under `read-only` while a confined child agent needs its state directory writable), and an approved escalated retry is a new call with a wider policy" — "inexpressible under a config-fixed provider mode" (sandbox.md, `SandboxPolicy` JSDoc; alternatives section of the sandbox Agent Note rejects "Config-fixed mode on the provider" for exactly this).
- `danger-full-access` consumers never call `ctx.sandbox` at all; only confined modes reach the provider (`ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>`).
- Root canonicalization: "canonicalized with filesystem semantics before lexical normalization, so a cwd containing `symlink/..` identifies the directory where a spawned process actually runs" (sandbox.md, Per-call policy).
- `ctx.sandboxPolicy.resolve()` owns precedence: **explicit approved mode > session's last `sandbox/mode` event > deployment default**; `SessionHeader.cwd` > configured fallback root (`packages/sandbox/sandbox-policy/src/index.ts:91`, generated API).

### 2.2 The ladder: one chain per platform, probed functionally

`dsh-sandbox-local` selects and caches one runner per provider lifetime (`packages/sandbox/sandbox-local/README.md`):

| Platform | Chain (in order) | Mechanism | Enforcement honesty |
|---|---|---|---|
| Linux | `bwrap` (functional probe) → packaged Landlock launcher | mount-namespace bind / Landlock UAPI ruleset | full / partial on older ABIs |
| macOS | Seatbelt `sandbox-exec` (sole candidate, not probed) | allow-default `(deny file-write*)` + write allow-lists | full (but the CLI is deprecated-by-Apple — a risk documented as fail-closed-on-removal) |
| Windows | ACL restricted-token runner (`dsh-sandbox-windows-acl`) | `CreateRestrictedToken(WRITE_RESTRICTED + DISABLE_MAX_PRIVILEGE + LUA_TOKEN)` | **partial** (Everyone grants + NTFS hard-link aliases) |

- Probes are **functional, not version checks**: "the chain probe is functional — it builds and enforces a real profile rather than checking `--version` — so a present-but-unusable `bwrap` fails its probe, selection falls to the packaged Landlock launcher, and the verdict is cached for the provider's lifetime" (sandbox Agent Note FAQ). Probing exists *to arbitrate between candidates*; a sole candidate is selected directly ("Functionally probe even a platform's sole backend — rejected: probing arbitrates between candidates", Alternatives).
- Unsupported platforms and unusable runners **fail closed** with structured `SANDBOX_UNAVAILABLE`; before the Windows rung shipped, `PLATFORM_CHAINS.win32` was "reserved and empty (fail-closed), pinned by test to fail closed identically" (sandbox Agent Note, Deferred phases).
- Seatbelt profile details: "allow-default with `(deny file-write*)` plus write allow-lists… `read-only` grants the `/dev/null` literal alone; `workspace-write` adds the workspace root, `/tmp`, and the per-user darwin temp dir… every root canonicalized because Seatbelt matches resolved paths (`/tmp` IS `/private/tmp`)" (`packages/sandbox/sandbox-local/README.md`).

### 2.3 The in-house Landlock launcher: audit-surface economics

The launcher is "a ~300-line C program (plain C11 over the raw Landlock UAPI — no libraries beyond a statically linked musl, so the audit surface is that one file plus the kernel's stable syscall contract)": `--ro/--rw` grants, installs the ruleset on itself and `exec`s (rulesets inherited across `execve`, sets `no_new_privs` before restricting), `--probe` "enforces a maximal ruleset in a short-lived child and exits 0 only when the kernel actually enforces", and every launcher failure exits **125** with a fatal `landlock-run:` line (sandbox Agent Note, Local backends). Binaries are "byte-pinned to native CI builds" of reviewed source — the explicit justification for rejecting third-party runners (§10).

### 2.4 Classification dialects: telling denial / runner failure / child failure apart

`confine(argv, policy)` returns `ConfinedArgv` — the wrapped argv plus three orthogonal facts (`docs/subsystems/sandbox.md`, Wrapped argv):

- `denialSignatures`: the backend's own **denial dialect** (EROFS text under bwrap read-only binds, EACCES under Landlock, EPERM under Seatbelt). "A consumer that infers denials from a failed run's stderr matches against exactly these rather than a cross-backend union — the union claims denials a given backend never produces."
- `runnerFailureRules`: `RunnerFailureRule` = optional `allowedExitCodes` + case-insensitive per-line `fatalSignatures` + exact full-line `informationalLines` exclusions; "Exit status alone never proves runner failure."
- `enforcement`: full/partial.

Consumers "check these first and surface a sandbox infrastructure failure, never an ordinary task failure." The signature API lives at `packages/sandbox/sandbox/src/index.ts:158` (generated catalog).

### 2.5 Postmortem 0004 — why the dialect machinery exists

`docs/postmortem/0004-landlock-partial-notice-misclassified-child-failures.md` (status: resolved) documents the motivating defect:

- **Bug**: one case-insensitive `landlock-run: ` substring treated any nonzero exit carrying it as runner failure. On partial-ABI kernels the launcher prints the *benign* `landlock-run: partial enforcement (older Landlock ABI)` notice before every child — so "ordinary outcomes such as ripgrep's exit 1 for no matches surfaced as `SANDBOX_UNAVAILABLE`". Compounded by the then-bash-backed filesystem search, which "caught every rejected bash run that was not aborted and replaced it with a generic… `SEARCH_FAILED`", hiding the structured error.
- **Root cause (representational)**: "The public sandbox result type could express only a bag of substrings. It could not state that Landlock failure requires exit 125, that evidence must occur within one fatal line, or that one exact line under the same prefix is informational."
- **Guardrails**: structured `RunnerFailureRule` (exit gate + fatal line after exact exclusions); `dsh-bash-sandbox` spawns the provider argv directly so pre-start rejection uses the spawn-error channel; fs search moved to "packaged ripgrep through `ctx.subprocess`", outside sandboxed bash; regression cases in `packages/shell/bash-sandbox/tests/partial-landlock.spec.ts` plus an assembled snapshot composition (`examples/acp-agent/partial-landlock.cordis.snapshot.yml`).
- **Honest limits**: "Stderr remains an in-band attribution channel. A confined child can deliberately reproduce a runner's gated fatal line and exit status, causing an availability/diagnostic false attribution… an out-of-band status protocol remains separate hardening, not a sandbox-bypass fix." Also stated in the sandbox note: "this is not a sandbox bypass because the child is already confined."
- **Lessons distilled**: "Process attribution requires a conjunction of independent evidence; a shared prefix is not a protocol" and "An adapter must preserve structured failures owned by the seam below it instead of replacing them with its own nearest generic category."

---

## 3. Escalation: one approved, strictly-wider retry

The escalation design (sandbox Agent Note, §Escalation) is the pressure valve that keeps operators from globally widening:

- A denied file effect returns `[sandbox: file access denied under <mode> mode]` plus instructions not to work around it. When a confining executor is mounted, `bash` advertises paired `sandbox_permissions` + `justification` fields — **capability-gated on the mounted executor, not on configuration** ("Advertise the escalation fields unconditionally — rejected: … they are a dead lever — advertising an option the harness cannot honor manufactures doomed grants").
- The retry must be **strictly wider than that call's effective mode**; a non-widening request "fails closed with its own text and prompts no one". The safety boundary is the execution-time strict-wider check, *not* the advertised enum (schemas are registry-global while effective mode is per-session — "a session already at the widest mode is still offered the fields. Harmless by construction").
- "Approval resolves before execution. `allowed-once` stamps the granted mode onto only that request, while `rejected`, `cancelled`, `unavailable`, a missing approval service, or a missing agent all fail closed with distinct results. **No grant is persisted.**"
- Escalation must be grounded in an actual denial ("except when the session already observed the same denied access"); the ask is owned by `dsh-tool-bash` because the executor "has neither the agent nor call id required for user interaction" ("Ask inside the executor — rejected").
- Auto-retry inside the same tool call is rejected: "a hidden re-entry the log cannot reconstruct: one `tool/call` would have produced two executions with different policies — the retry is a NEW logged call with its own arguments and result facts."
- Hard-match of the retry to a prior denial is rejected ("command-string identity is fragile… the real boundary is the human seeing command + justification").

Escalation in the fs family is identical: the sandboxed `ctx.fs` provider carries the same per-call policy and `FS_SANDBOX_DENIED` is "a POLICY refusal… distinct from `FS_PERMISSION_DENIED` (the host kernel refusing)" (`docs/subsystems/filesystem.md`, Error taxonomy).

---

## 4. The approval seam

### 4.1 Closed outcomes and fail-closed dispatch

`ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`; "A missing, non-owning, throwing, or non-conforming answerer becomes `unavailable` rather than opening the gate" (`docs/subsystems/approval.md`). `ctx.approval.request(req)` semantics (generated API, `packages/interaction/user-approval/src/index.ts:192`):

- Requests must sit **inside an open turn** — "the audit pair must be enclosed by the durable log's commit/replay boundary; an idle ask rejects before appending anything."
- "An aborted signal yields `'cancelled'`, a missing or throwing answerer yields `'unavailable'` (fail closed), and a rogue non-vocabulary return value is normalized to `'unavailable'`."
- "A failure that prevents either audit append from committing still rejects because returning an unlogged decision would violate the pair."
- `ApprovalRequest` **deliberately omits tool arguments**: "an answerer attaches the prompt to the already-streamed tool call through `callId` instead of rendering a second copy that could drift."

Answerers are `approval/request` **waterfall** listeners (`packages/interaction/user-approval/src/index.ts:30`, `@mode waterfall`): "Return an outcome to answer for an owned agent or call `next()` to delegate"; agent-scoped listeners receive only that agent. The ACP automation bridge supplies "one-shot machine decisions for sessions it owns" (`packages/interaction/user-approval/README.md`).

### 4.2 Per-session policy: the session log as the store

`ApprovalPolicy = 'ask' | 'never'`. `'never'` "deterministically returns `rejected` without dispatching any answerer… The strict headless stance (CI, unattended runs)". Critically, "The `never` policy is enforced inside the service before waterfall dispatch, so even an answerer registered later with `prepend` cannot bypass it" (approval.md, Dispatch and audit).

Effective value = "the last `approval/policy` event in the session log, falling back to the service config. `setApprovalPolicy(session, policy)` is the single write path, so replay reconstructs the override." The knobs share one event-sourced pattern — one event per knob, owned by its domain, with "a pure fold (`effectiveSandboxMode`/`effectiveApprovalPolicy` — a `findLast`), and THE write path… No shared owner service, no generic facts map, no registry" (sandbox Agent Note, Per-session modes). Restart immunity and multi-session isolation "follow from replay, with no external config store."

### 4.3 Audit and model-visibility discipline

"The audit events are log-only and do not enter the model transcript. Model-visible behavior is the caller's derived tool result plus the current runtime-context snapshot" (approval.md). The model-visible policy statements are pinned templates — under `never`: "Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation" (`packages/interaction/user-approval/README.md`, Model Experience). A telling shipped-then-reverted decision: stating the sandbox mode in the stable system prompt made the model "refuse to ATTEMPT denied-then-escalatable work (five of twelve turns in the first manual session ended with zero tool calls), turning the sandbox into a soft lockout" — removed on live evidence (sandbox Agent Note, Alternatives).

### 4.4 Subagent approvals pinned to `'never'`

`2026-08-10-subagent-approval-pinned-never.md`: delegated children "act only within the permission scope fixed at delegation, and approval prompts are removed from its world entirely" — `captureDelegatedPolicyOverrides` snapshots the parent's sandbox override but **pins `approvalPolicy: 'never'`**, written as a durable `approval/policy { policy: 'never', source: 'delegation' }` event. Rationale: a child's ask under an interactive parent "became a pending question no product surface showed… a permission-blocked child was indistinguishable from a working one." Children are told, not trapped: a `subagent:delegation` runtime-context statement says the scope was fixed at start and "a task needing wider access ends with a reported limitation instead of retries." The audit pair is still logged on the child's log even under `never`.

---

## 5. Permission presets: UI bundling without new enforcement

`ctx.permissionPresets` bundles `sandbox/mode` + `approval/policy` into named presets (default table: `workspace-write` = workspace-write + ask; `danger-full-access` = danger-full-access + never). Design discipline (`docs/subsystems/permission-presets.md`):

- It "owns no enforcement: execution, prompt narration, and replay keep reading their knob folds, and a preset switch only records intent and writes through each knob's canonical setter."
- **Fails loud at load**: "a table entry named `custom` throws (the name is reserved for the derived not-a-preset state), and composing over a bash executor that does not confine (no `sandboxMode` capability fact) throws, because presets bundle a sandbox mode."
- `current(events)` **derives** the effective preset from the knobs, never from its own event: unmatched combinations fold to the derived `custom` state ("unmatched knob values are reported as CUSTOM_PRESET, not an error").
- Switching appends a log-only `permission/preset` event *before* the knob events, and "re-selecting the effective preset appends nothing at all" — the event exists so `current()` can preserve WHICH preset the user chose "when two presets share a bundle."

---

## 6. Credentials: references, per-operation resolution, scrubbing

### 6.1 The reference model

"Settings sections and `cordis.yml` entries carry *references* (environment-variable names), providers… own the values, and consumers resolve a reference once per operation — the LLM adapters resolve once per model request, so a rotated credential reaches the very next request without any restart" (`docs/subsystems/credentials.md`). `CredentialRef` is a branded POSIX env-var name; "an empty stored value is absent everywhere — `resolve` skips it, `describe` reports it unconfigured — so a blank never masquerades as a configured secret."

`describe()` returns facts "safe for configuration UIs — never the value" (`CredentialInfo`: configured/source/writable). The local provider reports a live-process-env-supplied reference as `writable: false` and `set`/`unset` **reject** — "the write would appear to succeed while resolution kept returning the shadowing value" (`packages/credentials/credentials-local/README.md`).

### 6.2 Four layers, one honest precedence

`env` (inherited process environment, wins always, read-only) > `file` (`$DSH_HOME/.credentials.yaml`, the only writable store) > `project-env` (invoking-cwd `.env`) > `user-env` (`$DSH_HOME/.env`) — table in `packages/credentials/credentials-local/README.md`. The launching environment wins because "a per-run override… is operator intent for this run — and because it cannot be edited from inside, it must be *visibly* read-only". The document "holds credentials only, so every deviation is a rejection rather than a skipped entry"; writes re-read under a cross-process lock and "commit atomically with mode `0600` under an owner-only (`0700`) directory". Under the product CLI, resolution reads "the launcher's frozen environment snapshot… rather than `process.env`: only the snapshot can say whether a value came from the launching shell or from a file."

### 6.3 Env hygiene in the subprocess seam

The subprocess seam "owns the managed `DSH_*` environment namespace, the shared credential scrub (`scrubbedParentEnv`)" (`docs/subsystems/subprocess.md`):

- Ambient `DSH_*` names are **discarded before** the caller's explicit `env` merges — "a current fact arrives only as a deliberate string entry, while an explicit `undefined` tombstone removes an ordinary ambient value." Merge order is enforced: ordinary `env` first, managed `dshEnv` **last**, "so a caller `env` entry can never displace a managed one" (`ShellExecRequest.dshEnv` JSDoc, `docs/subsystems/shell.md`).
- The scrub pattern from `docs/defensive-patterns.md`: "Spawned commands get a scrubbed env (drop `*KEY*`/`*SECRET*`/`*TOKEN*`/`*PASSWORD*`) so harness credentials cannot leak into output, `env`, or spill files."
- `stdin` and `env` on the shell request are **trusted in-process plugin inputs** and "are not exposed by `dsh-tool-bash`" (the model cannot set them); same for `stdoutMaxBytes` (`.agents/notes/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-api.md`).
- `resolveExecutable` "verifies absolute executable paths or resolves bare names through the provider's scrubbed `PATH`… Relative paths containing separators are rejected: the resolution base is undefined, so providers fail loud instead of guessing" (generated `ctx.subprocess` catalog).

---

## 7. The execution-world family: one policy, many enforcement points

### 7.1 fs fence shares the runner's roots

`SandboxedFileSystem` (`packages/fs/fs-sandbox/README.md`) "extends `LocalFileSystem`… and adds only a per-call MODE fence on `writeText`/`editText`. Reads always pass through." The fence's writable roots are "the SAME set the Seatbelt profile grants, derived from the one `writableRoots` function so the fs fence and the bash runner cannot drift," and "The target is re-canonicalized immediately before delegating, so an ancestor symlink swapped since the tool resolved it is caught."

### 7.2 Threat-model honesty: fence, not kernel boundary

The README is explicit: "The fence is a check in TRUSTED code over a MODEL-CONTROLLED path — the operations are the seam's own (open, rename), only the target path is untrusted, so canonicalize-then-contain is the complete answer to this surface… **containment, not a security boundary**. Kernel-grade isolation of untrusted CODE stays `ctx.shell`'s job." The residual TOCTOU "is narrowed by re-canonicalizing immediately before the write and is accepted for this threat model; a kernel-tight boundary needs `openat2`-class primitives not worth their portability cost here." Unlike bash's stderr-inference, the in-process denial is structured: `FS_SANDBOX_DENIED` "carrying the effective mode — no stderr text inference… because an in-process fence knows exactly what it refused."

### 7.3 Observation policy: read-before-write as an optional plugin

`dsh-fs-observation-policy` changes fs semantics **through events, not by patching the tool**: "`fs/write-intent` and `fs/edit-intent` are single-slot decision waterfalls… the tool dispatches each with a default thunk returning `undefined` (the bare provider), and a listener fully decides without calling `next()`" (`docs/subsystems/filesystem.md`). Authorization is **freshness-based**: a windowed read emits a present `fs/observed` with the stat's version, so "any windowed read can authorize a later write/edit when the file is unchanged"; a metadata miss emits an absent observation "allowing a later guarded write to recreate an externally deleted target without authorizing edit." Guarded writes are no-replace/no-stale: `createIfAbsent` rejects an existing target with `FS_NOT_OBSERVED` "including a target that appears after the provider's initial probe because publication itself must be no-replace"; `editText` verifies the version "BEFORE literal matching (so a stale edit reports `FS_STALE_VERSION`, not a match failure against newer content)" and keeps "matching, line-ending handling, the stale check, and atomic replacement inside one mutation critical section."

Trust-boundary primitive: `lstat` exists precisely because "`resolve` intentionally follows symlinks to produce stable identity; consumers that need trust-boundary checks can call `lstat` first and reject `symlink` before resolving" (filesystem.md, Target identity).

### 7.4 Same-world sharing across Bash/PTY/LSP

"Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks" (`docs/architecture.md`). Concrete coordinates: `ctx.fs.processPath(target)` "returns the canonical absolute path a subprocess in this filesystem's execution world can open… consumers may pass this value to another OS capability, but must continue treating the target key as opaque." Terminal sessions are authorized by **exact owning Agent** ("authorization compares the exact owning `Agent`, not a name or guessed id", `docs/subsystems/terminal.md`), with backend cleanup obligations: "A backend that cannot clean partial startup resources rejects with `TerminalBackendCleanupError`", and `close()` is "Idempotent… await quiescence."

---

## 8. Defensive patterns: rules and the bugs behind them

`docs/defensive-patterns.md` (33 lines, every pattern quoted) — "each pattern below is a class of defect that actually shipped or nearly shipped here, stated as the rule that prevents its recurrence."

1. **"Report orthogonal outcomes independently"** — "a process can time out AND exit 0 because it trapped the signal. Surface each independent fact (`timedOut`, `signal`, `exitCode`) on its own; never nest one flag's report inside another's branch, or a caller reads a cut-short run as a clean success." Runtime shape: `ShellRunResult` carries `exitCode`, `signal`, `timedOut`, `aborted` as **independent** fields, with `timedOut`/`aborted` mutually exclusive via "the FIRST cause" classification ("one fused deadline drives both", `docs/subsystems/shell.md`). The subprocess seam deliberately refuses classification: `SubprocessOutcome` "carries NO timeout or cancellation classification (the caller reads the signal it owns)".
2. **"Honor public contracts on BOTH sides"** — normalize outcome representations at the API boundary; the cited example is `LlmAdapter.stream()` (may throw OR emit error finish) vs `LlmRuntime.stream()` (exposes model-request failures "only as terminal finish chunks; middleware and consumer defects remain thrown"). This is the same discipline postmortem 0004 violated ("An adapter must preserve structured failures owned by the seam below it").
3. **"Async state is not synchronous state"** — `agent.followup()` "has no per-message completion or result… several queued follow-ups, steering, and injected work may share one `running` interval" — never attribute an outcome to one message by observing `whenIdle()`.
4. **"Dispose must reach quiescence, not just request it"** — "Make cleanup async and await the children's exit (kill → await `done`), and close listener/notification registries BEFORE killing so late completions stay silent." Runtime shapes: `SubprocessHandle.terminate()` escalates "SIGTERM → `graceMs` → SIGKILL — the only termination verb — tree-scoped on every platform" (POSIX process groups; Windows `taskkill /T`), and `waitForExit()` "observes the whole tree… so a still-running helper is observable before teardown returns"; service disposal "terminates all still-running managed processes and awaits their exit."
5. **"Contain callback exceptions in the dispatcher"** — "A user-supplied listener that throws must not reject the promise it runs inside or starve the listeners after it. Wrap the dispatch loop in try/catch and log; one bad subscriber never breaks core lifecycle."
6. **"Never hand untrusted output the ambient environment or predictable paths"** — the credential scrub + "Temp/spill files use a private (0700) dir, random names, and exclusive owner-only opens (`'wx'`, `0o600`) — predictable world-readable paths invite symlink races and disclosure." Complementary: `credentials/updated` listener failures are "contained and logged… except `INVARIANT`-coded failures, which rethrow after every listener ran" (so invariant checks on that event "must not be async functions").
7. **"Unlink link-shaped paths"** — "A path that may be a symlink or Windows junction is removed with `lstatSync().isSymbolicLink()` then `unlinkSync`… Reserve recursive `rmSync` for known real directories." (Windows `rmSync(link)` throws `ERR_FS_EISDIR` on a junction; "recursive deletion may descend through one into its target.")

Note the family resemblance between patterns 1 and 2 and the sandbox dialect machinery of §2.4 — all three encode the same meta-rule from postmortem 0004: "a shared prefix is not a protocol."

---

## 9. Postmortem 0002: configuration truth vs. security intent

`docs/postmortem/0002-js-expression-disabled-filesystem-tools.md` (status: resolved):

- **Bug**: ACP composition used `disabled: !!js ...` on filesystem plugin entries, but "Cordis evaluates JavaScript expressions only inside plugin `config`… `Entry.disabled` tests `entry.options.disabled` **without interpolation**" — "The raw expression object was truthy, so the filesystem stack was always disabled" in every mode. Snapshot refresh then "accepted `UNKNOWN_TOOL` results as new expected outputs" — "it proved deterministic replay of the regression rather than successful filesystem behavior."
- **Security analysis is the sharpest part**: "The live confined default did not gain unintended filesystem access. A naive interpolation fix would have created that risk: permission presets update bash sandbox and approval state at runtime, but **cannot mount, unmount, or confine the filesystem stack**." Hence the lesson: "Permission controls must describe only the capabilities they actually govern. Composition-time filesystem access cannot follow a runtime bash-only preset safely."
- **Guardrails**: an explicit `fs.cordis.yml` full-access overlay for snapshot scenarios; documented `!!js` scope (Cordis primer §Loader Configuration); `verify-cordis-config` "rejects expression nodes in Loader entry metadata"; `dsh-acp-snapshot` "rejects structured `UNKNOWN_TOOL` results in fresh runs and committed session fixtures."
- **Test lesson** (mirrors pattern 1's spirit): "A snapshot refresh is fixture production, not correctness review. Semantic impossibilities such as a missing registered tool need assertions independent of the expected output."

---

## 10. What got REJECTED (and the recorded rationale)

### 10.1 landstrip as the Windows rung (and for Linux)

`.agents/notes/rejected/feature/2026-07-26-evaluate-landstrip-for-windows-sandbox-rung.md` — status line: "rejected — **landstrip is not battle-tested** (a days-old single-maintainer project, ~48 GitHub stars at rejection); a security-invariant dependency must have proven adoption, so the win32 rung keeps the in-house-launcher plan." The note frames it as an evaluation gate, not an adoption: probe synthesis (landstrip has no `--probe`), dialect mapping, LGPL-2.1 license review, and "Source and build record" — "Each in-house launcher binary is byte-pinned to a native CI build of a ~300-line reviewable C file; landstrip is a single-maintainer Rust binary set." Swapping the *existing Linux* rung was "Rejected outright: sandbox correctness is a security invariant… it already migrated away from a Rust dependency for exactly this reason." Risk recorded: "Single-maintainer supply chain in a security-critical position."

### 10.2 Windows rung alternatives: mxc and AppContainer

`2026-08-08-windows-acl-restricted-token-sandbox.md` disqualifies both by the **arbitrary-read cost**: an identity route (AppContainer, landstrip's Windows backend, mxc's T1/T3) "starts with zero ACEs on the host's files — everything, reads included, defaults to denied, and every path the child may touch must then be opened back up by writing ACEs" — "wholesale host DACL mutation." mxc additionally fails on OS floor (24H2/25H2). The chosen `WRITE_RESTRICTED` restricted token "performs the access check twice — once against the normal SIDs, once against the restricting SIDs — and grants write-class access only where both checks pass. Reads pass on the normal check alone… which is why this rung needs no read grants and no new account." Failure honesty: "this port checks every API call and fails closed (the POC fail-opened on ignored failures)." Structural limits accepted and *reported*: Everyone grants + NTFS hard-link aliases ⇒ `enforcement: 'partial'`; the native suite "pins both gaps."

### 10.3 Dropping bash output spill files

`.agents/notes/rejected/simplification/2026-06-20-drop-bash-output-spill-files.md` — rejected because "full-output recovery is a real bash behavior," but the note's security analysis is the interesting half: "A spill path is a process-local filesystem artifact exposed to model output, not a durable harness artifact with scoped access, retention, or UI affordances" — i.e., the rejection explicitly defers to a future artifact service with "explicit ownership, cleanup, and UI rendering."

### 10.4 NIH-audit verdicts with security weight

`.agents/notes/rejected/simplification/2026-07-26-dependency-swaps-rejected-by-nih-audit.md` records ~30 rejections; security-load-bearing ones:

- **`shell-quote` for POSIX single-quoting** — "two 1-line quoting helpers with exhaustive tests versus a maintenance-mode package with a CVE history and different escaping output — **a safety boundary is the wrong place to save one line**."
- **`structuredClone` for session snapshot/validator** — "it is a validator + detacher enforcing the lossless-JSON boundary with single-read-per-getter and **cross-realm intrinsic checks**; `structuredClone` accepts Map/Date/-0 and enforces nothing" (prototype-pollution hardening a generic clone cannot replace; same for the `code-runtime-worker` mirror "hardened against a model-mutated realm").
- **Ajv for the tools JSON Schema validator** — "the validator also does realm-intrinsic prototype checks Ajv does not."
- **`write-file-atomic`** — rejected because the hand-roll carries "the private 0700 staging dir, Win32 DACL copy/`ReplaceFileW`, AbortSignal support, and parent-dir fsync — each the point of the hand-roll."
- **`execa` / `tree-kill` / `pidtree`** — teardown-semantics mismatches in exactly the code "whose semantics are teardown races" (stdin-EOF-first cooperative tier, start-time identity against PID reuse).
- **`strip-ansi` for pty sanitization** — the streaming state machine also feeds "OSC `133;D` prompt-marker extraction (the shell-readiness signal)"; `stripVTControlCharacters` "demonstrably leaks unterminated-OSC payloads the session-title normalizer must strip (**anti-spoofing**)."

### 10.5 Rejections from the sandbox note itself (design-level)

Command-string heuristic preflight ("cannot understand expansion/subprocesses/symlinks; the strict attempt… is the only trustworthy denial signal"); committing built binaries ("a binary in a diff is unreviewable"); compile-on-install ("a fallback that exists only where a compiler happens to be is not a fallback"); a generic ToolRuntime wrapping any tool ("mechanically false for in-process tools — closures over `ctx`"); one interface spanning containers/VMs ("`confine(argv)` presupposes a shared filesystem; environment isolation is capability-sibling backends deployed as coherent groups"); a default-relative escalation ladder ("per-session overrides make the default the wrong baseline"); per-session dynamic tool schemas; a generic `env/state` facts map ("no invariant spans the knobs, so atomic multi-key patches bought nothing").

---

## 11. Design decisions & trade-offs (summary)

| Decision | Payoff | Accepted cost / honest limit |
|---|---|---|
| Per-call `SandboxPolicy` carriage | concurrent consumers + one-shot escalated retries; provider stays stateless | resolution is an explicit consumer-boundary step |
| Functional probes, cached per provider lifetime | present-but-unusable runners detected, not assumed | installing/repairing a runner requires plugin reload |
| In-house ~300-line C launcher, CI byte-pinned | auditable supply chain for a security invariant | owning native repos (the reason landstrip lost) |
| `full`/`partial` enforcement reporting | never overstates a boundary (Landlock old ABI, Windows Everyone/hard-link) | consumers "must not treat partial as full" — responsibility pushed to callers |
| Escalation = one strictly-wider approved retry | pressure valve that keeps default confinement usable; auditable asks | model may over-ask ("the human prompt is the actual gate"); no persisted grants (`allow_always` scope left open) |
| Session-log as policy store (`findLast` folds) | restart immunity, multi-session isolation, replayable policy | append-only history; older snapshots retained |
| Subagent approvals pinned `never` | no invisible blocked-waiting children; deterministic | no child answerer without reversing the note first |
| Presets = pure bundling over two knobs | no second enforcement path; `custom` derivation honest | no cross-knob invariants possible by design |
| Credential references + per-operation resolution | rotation without restart; secrets never in config | providers must implement the empty-is-absent rule everywhere |
| `scrubbedParentEnv` + managed `DSH_*` merge-last | credentials can't leak into child env/output; no stale managed facts | explicit caller opt-in can still forward a credential-shaped entry (documented, deliberate) |
| fs fence shares `writableRoots` with Seatbelt | bash and fs "cannot confine to different roots" | fence is containment-not-boundary; TOCTOU narrowed, not eliminated |
| In-band stderr attribution (postmortem 0004) | works across arbitrary runners with dialect rules | confined child can mimic a runner failure line — availability issue, not a bypass |
| Waterfall answerers / single-slot fs intents | composable policy without emitter↔listener coupling | slot ownership is "a deployment convention, not an enforced invariant" |

---

## 12. Evidence appendix

Subsystem docs (each with generated Cordis-surface sections carrying source line refs):
- `docs/subsystems/sandbox.md` — modes, per-call policy, `ConfinedArgv`, `RunnerFailureRule`, fail-closed; `confine` at `packages/sandbox/sandbox/src/index.ts:158`; `resolve` at `packages/sandbox/sandbox-policy/src/index.ts:91`.
- `docs/subsystems/approval.md` — outcomes, policy, request contract, audit pair; service at `packages/interaction/user-approval/src/index.ts:192`; `approval/request` waterfall at `:30`.
- `docs/subsystems/permission-presets.md` — preset table, derived `custom`, switch semantics; service at `packages/interaction/permission-presets/src/index.ts:159`.
- `docs/subsystems/credentials.md` — refs, resolution, describe, updated event; seam at `packages/credentials/credentials/src/index.ts:60`; event at `packages/credentials/credentials/src/types.ts:29`.
- `docs/subsystems/filesystem.md` — targets/versions, write/edit guards, `fs/*` events (waterfalls at `packages/fs/fs/src/index.ts:58/66`, `fs/observed` emit at `:76`), error taxonomy incl. `FS_SANDBOX_DENIED`; `ctx.fs` at `packages/fs/fs/src/index.ts:86`.
- `docs/subsystems/subprocess.md` — `DSH_*` namespace, `scrubbedParentEnv`, stdio dispositions, tree-scoped termination; seam at `packages/subprocess/subprocess/src/index.ts:102`.
- `docs/subsystems/shell.md` — request/spec split, env/dshEnv merge order, `ShellSandboxInfo`, `ShellRunResult` orthogonal fields; executor at `packages/shell/shell/src/index.ts:65`; `ctx.shellEnv` registry at `packages/shell/shell-env/src/index.ts:89`.
- `docs/subsystems/terminal.md` — exact-owner authorization, cleanup errors; service at `packages/terminal/terminal/src/index.ts:105`.
- `docs/subsystems/typert.md` (skim) — lookup definitions retained after provider unload ("fails unavailable instead of accepting the wire value as an ordinary business object") — fail-closed remote-call typing; no sandbox content.

Agent Notes (decision records):
- `.agents/notes/implemented/feature/2026-07-06-sandbox.md` — the master sandbox decision: seam, chains, launcher, escalation, per-session modes, alternatives, consequences, FAQ (quoted: fail-closed text at line ~41; Windows deferred at ~131; escalation semantics ~161; enforcement-partial and in-band-attribution limits ~174-181).
- `.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md` — restricted-token design, mxc/AppContainer disqualifiers, Everyone/hard-link partial boundaries.
- `.agents/notes/implemented/feature/2026-08-10-subagent-approval-pinned-never.md` — delegation permission pinning.
- `.agents/notes/rejected/feature/2026-07-26-evaluate-landstrip-for-windows-sandbox-rung.md` — landstrip rejection (status line quoted verbatim).
- `.agents/notes/rejected/simplification/2026-06-20-drop-bash-output-spill-files.md` — spill-file rejection and its model-output exposure analysis.
- `.agents/notes/rejected/simplification/2026-07-26-dependency-swaps-rejected-by-nih-audit.md` — dependency rejections incl. shell-quote/structuredClone/Ajv/write-file-atomic/execa/pidtree/strip-ansi verdicts (security-relevant subset quoted).
- Related implemented notes referenced by the above: `2026-07-06-approval-seam.md`, `2026-07-14-cross-family-fs-sandbox.md`, `2026-07-30-current-sandbox-policy-context.md`, `2026-07-31-permission-default-for-new-sessions.md`, `2026-07-23-web-permission-and-approval.md`, `2026-07-25-subagent-policy-inheritance.md`, `2026-06-30-bash-stdin-env-trusted-plugin-api.md`.

Postmortems and rules:
- `docs/postmortem/0002-js-expression-disabled-filesystem-tools.md` — `!!js` scope bug, UNKNOWN_TOOL snapshots, permission-controls lesson (all quotes above).
- `docs/postmortem/0004-landlock-partial-notice-misclassified-child-failures.md` — attribution bug, `RunnerFailureRule` guardrails, in-band-channel honesty.
- `docs/defensive-patterns.md` — all seven patterns quoted in §8.

Package READMEs:
- `packages/sandbox/sandbox-local/README.md` — chain order, Seatbelt profile, partial-enforcement limitations, `runnerCommand` operator-assertion caveat.
- `packages/fs/fs-sandbox/README.md` — mode fence, shared `writableRoots`, "containment, not a security boundary" threat model.
- `packages/credentials/credentials-local/README.md` — layer table, honest writability, 0600/0700 atomic writes, launch-environment snapshot.
- `packages/interaction/user-approval/README.md` — fail-closed summary, model-visible policy templates.

Architecture:
- `docs/architecture.md` — capability-seams paragraph (Bash/PTY/LSP move with one provider swap); `docs/glossary.md` §capability-seam (three roles).
