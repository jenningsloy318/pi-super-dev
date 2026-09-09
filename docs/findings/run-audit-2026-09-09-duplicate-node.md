# Run audit — 2026-09-09: duplicate_node abort (run 2026-09-08T23-27-36-732Z)

Spec 26 (capability backends), pi-omosis worktree, super-dev v0.3.83 serving copy.
Run aborted 11:14:40 via the v0.3.65 fuse: `spec convergence: writer agent errored
3 consecutive round(s) — infra failure, not an artifact defect (last error:
delegation ended with status duplicate_node)`.

## Timeline (all times +08:00, 2026-09-09)

| Time | Event |
|---|---|
| 10:39 → 10:59 | spec-writer round 1: pi-subagents internal timeout at exactly 1200s (`terminal status=timed_out`, $1.12) |
| 11:00 → 11:18 | round 2 **completed** in 1082.9s — all three docs (~62KB: spec 22KB + plan 29KB + tasks 11KB) |
| ~11:20 → 11:40 | round 3: internal timeout at exactly 1200s ($0.83) |
| 11:41 → 12:01 | round 4: OUR wrapper fires at 1200s+2s grace — cancel emitted, NO pi-subagents terminal line, `model=unknown` |
| 12:01:40.065 | round 5 dispatched **182ms** after round-4 stage end |
| 12:01:40.117 | round-5 request → rejected in **43ms**: `delegation ended with status duplicate_node` |
| 12:01:40 | v0.3.65 fuse: 3rd consecutive agent error → FatalAbort (healthy: no fake rejections, honest abort) |

## Root cause (three co-factors, all verified in source)

1. **Deterministic nodeId** — `delegation-backend.ts:280` composed
   `nodeId = opts.id ?? \`pipeline.${agent}\``: the logical-node id is stable
   per agent, so a retry of the same agent reuses the exact
   `(ownerRunId, nodeId)` tuple. The header comment called it "the per-call
   id" — no call-unique component ever existed.
2. **Async cancel-settle in pi-subagents** — a still-ACTIVE node with the same
   tuple is rejected with terminal `duplicate_node`; `cancel → controller.abort
   → in-flight executeRequest rejects → finally removes the node` is async
   (observed settle window < 1s).
3. **Wrapper-races-internal** — our timeout wrapper cancels at
   `timeoutMs + 2000` while pi-subagents' internal child deadline starts at
   child-start (`emit + Δ`); whenever `Δ > 2s` our cancel fires FIRST (round-4
   shape: no terminal line, `model=unknown`), and the convergence loop
   re-dispatches the next round immediately (182ms) — inside the settle
   window.

Plus the enabling workload fact: **spec-writer writes all three spec docs in
one call** and ran at 90-100% utilization of the 20-min default tier (3 of 5
rounds at exactly 1200s; the one completion took 1082.9s) — the timeouts that
triggered the race were themselves near-certain.

## Class fix (v0.3.84)

| Fix | Mechanism |
|---|---|
| Per-attempt unique nodeIds | `nodeId = <base>@<requestId>` — a settling predecessor can structurally never collide with its successor; logical base stays in the prefix (caller `opts.id`, log semantics unchanged); cancel event carries the same composed tuple |
| duplicate_node bounded retry | ONE backoff retry (`SUPER_DEV_DUPLICATE_NODE_RETRY_MS`, default 2000) on either shape (terminal status / bridge rejection naming it); the attempt never started (43ms, zero usage) so the retry is free; a second duplicate stays an honest error (the 3-consecutive fuse owns persistence) |
| spec-writer 30-min tier | `HEAVY_WRITER_TIMEOUT_AGENTS = {spec-writer}`, `SUPER_DEV_WRITER_TIMEOUT_MS` (default 1_800_000 = worst observed completion + 50%, the v0.3.73 M4 calibration); surgical on evidence — other doc writers stay on the 20-min default |

## Bonus fix shipped in the same wave (M5 hermeticity class, triggered live)

Setting `SUPER_DEV_DEFAULT_TIMEOUT_MS=3600000` in `~/.super-dev/config.json`
(to unblock the resume — effective: `timeout=3600000ms` on every request of
run 2026-09-09T03-20-51-260Z) instantly broke
`tests/agent-runtime.test.ts`'s default-tier assertion: the file's local
`vi.mock(super-dev-dir)` spreads `...actual`, restoring the REAL
`superDevEnv` (overriding the suite stub), and its intra-module
`getConfig` call bypasses the namespace mock → the developer's live
config.env flowed into tier resolution. Dormant since v0.3.15. Fixed with a
kill-switch inside the implementation (`SUPER_DEV_NO_CONFIG_ENV=1`, pinned by
the vitest setup; production precedence unchanged) — seals all ~10 local-mock
files at once.

## Operational note

The 60-min env override is a valid immediate unblock (uses the designed v0.3.74
P1-c knob, read per call, no restart), but it raises failure-detection latency
for ~15 default-tier roles (a hung agent burns 3×60min before the fuse vs the
calibrated 3×20min). With v0.3.84 the override can be dropped: spec-writer
gets its own 30-min tier independent of the default knob.

## What worked (no fix needed)

- v0.3.65 fuse: honest `writer agent errored` labels, no fake "review
  rejected" rounds, abort exactly at 3 consecutive FRESH rounds.
- Round-2's completed spec-writer result was resume-cache persisted; the
  follow-up resume (03-20-51-260Z) replayed requirements/design cleanly and
  re-runs spec with the 60-min override in effect.

## Residual risk (dual review 2026-09-09, ADV-F3)

Co-factor 3 (pi-super-dev's own timeout wrapper can fire before pi-subagents
reaps the child) remains unfixed upstream of us. With per-attempt unique
nodeIds, the old loud `duplicate_node` rejection is traded for a brief
(< 1s, bounded by the child's own timeout handling) two-writer overlap window
in the same worktree: a timed-out-but-still-settling child and its retry can
run concurrently for that sub-second window. Accepted: the window is bounded,
the rejected-before-start duplicate path keeps zero cost, and the consecutive
agent-error fuse owns anything persistent. Documented here rather than fixed
(a true fix needs pi-subagents-side reaping coordination).

## Dual-review fold (2026-09-09)

- C1/ADV-F1 (P2/P3): production kill-switch line now pinned by the
  `config-env.test.ts` source-contract test (twin test alone could not catch
  deleting the guard).
- C2 (P3): `duplicateNodeRetryMs` clamped to 60s; backoff sleep is
  signal-aware and an aborted parent skips the retry, surfacing the honest
  duplicate error instead of racing a cancelled run. Actual wait lands in the
  progress line (P10).
- N1/ADV-F5 (nit): surgical-tier test now pins real roles
  (`bdd-scenario-writer`, `handoff-writer`); the v0.3.84 describe was un-nested
  from v0.3.74's.
- ADV-F4: `SUPER_DEV_NO_CONFIG_ENV` added to the README env table.
- Both reviewers verified the core fix against the installed pi-subagents wire
  contract (0.64/0.65.1/0.66.0): nodeId `@` shape legal, duplicate keying on
  `(ownerRunId, nodeId)`, retry bounded ≤4 attempts/call in every
  interleaving, no usage laundered or lost, no consumer parses the old shape.
