# Config-file env settings (v0.3.15)

Status: implemented (this commit — v0.3.15)

## Problem

~40 user-facing `SUPER_DEV_*` tunables (timeouts, budgets, kill-switches,
model/backend selectors) are readable ONLY via `process.env`. When pi (and
therefore the super-dev extension) is launched from a GUI — no shell profile,
no `env` prefix — there is no practical way to set them persistently. The
existing `~/.super-dev/config.json` recognizes only the 10 `SuperDevConfig`
keys (retention, escalation, agentModels); every other key is silently
ignored.

Evidence class: runs 2026-08-18T01-16 / 2026-08-23T00-59 died on timeout
budgets (`JUDGE_TIMEOUT_MS`, the 480s spec-writer wall) that the user could
not raise without an env-var channel through the GUI launch path.

## Design

One new config key, `env`, holding a flat string map:

```json
{
  "escalation": "informative",
  "agentModels": { "...": "..." },
  "env": {
    "SUPER_DEV_JUDGE_TIMEOUT_MS": "240000",
    "SUPER_DEV_MAX_REPLAN_ROUNDS": "3"
  }
}
```

**Access contract** — new accessor in `src/render/super-dev-dir.ts` (the
config owner; a leaf module importing only `node:*`, so no cycles):

```ts
export function superDevEnv(key: string): string | undefined
```

1. `process.env[key]` wins when set to a NON-EMPTY string (a one-off shell
   override must beat the persistent file — git-config semantics; an
   empty-string env var is treated as unset so a GUI-inherited empty var
   cannot silently mask a configured value).
2. Otherwise `getConfig().env[key]` (mtime-cached) when it is a non-empty
   string.
3. Otherwise `undefined`.

**Documented exception**: gates.ts tier (ii) keeps the pre-existing
`SUPER_DEV_BUILD_TEST_PACKAGES` set-but-empty escape hatch by ALSO consulting
`process.env` for definedness at that site — "" there still means "force
workspace-wide, skip auto-detect", exactly as before v0.3.15.

**Test hermeticity**: a vitest setupFiles mock
(tests/setup/config-env-hermeticity.ts) stubs `superDevEnv` to an env-only
passthrough for the whole suite, so a developer whose config.json populates
`env` (the feature's own target user) still gets a green suite. The real
implementation is pinned by a source-contract test in tests/config-env.test.ts.

All ~40 user-facing read sites (16 files) switch from `process.env.SUPER_DEV_X` to
`superDevEnv("SUPER_DEV_X")`. Call sites that already thread an injected env
object for testability (`skillsEnabled(env)`, `rpcSpawnEnabled(env)`) keep
their injection seam and call `superDevEnv` as the default source.

**Excluded on purpose**

- `SUPER_DEV_DIR` — bootstrap: config.json itself lives there (circular).
- Internal plumbing vars never meant as user settings:
  `SUPER_DEV_SO_SCHEMA`, `SUPER_DEV_SO_CAPTURE` (subprocess structured-output
  IPC), `SUPER_DEV_PANEL_SHORTCUT`, `SUPER_DEV_VERSION_METADATA`,
  `SUPER_DEV_VERSION_POLICY` (release tooling), `SUPER_DEV_EXTENSION_NAME`,
  `SUPER_DEV_EXTENSION_VERSION`.
- `src/build-runner.test.ts` fixtures keep raw `process.env` writes — they are
  the harness, not consumers.

**Config bootstrap order caveat**: `superDevEnv` reads `getConfig()` lazily on
each call (no module-load-time snapshot), so a config.json written mid-run is
picked up by later calls; tests that write config fixtures must restore.

## Verification

- RED-first: tests asserting `superDevEnv` honors precedence (env beats file,
  file beats absent, non-string entries ignored) and asserting at least one
  real consumer (`judgeTimeoutMs` via `SUPER_DEV_JUDGE_TIMEOUT_MS`) reads the
  config path — confirmed failing before the accessor exists.
- Typecheck + full suite green; version 0.3.14 → 0.3.15; CHANGELOG bullet.
- Dual systematic review (code-reviewer + adversarial-reviewer) on the change
  set before commit.
