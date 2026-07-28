# Requirements: SUPER_DEV_INHERIT_EXTENSIONS opt-in: let spawned specialists load ambient extension-registered providers

- **Date**: 2026-07-28
- **Author**: super-dev:requirements-clarifier
- **Type**: bug-fix
- **Priority**: high
- **Status**: draft

---

## Executive Summary

Specialist `pi` agents spawned by the pipeline both deliberately suppress ambient extensions (`--no-extensions` in the subprocess backend at `src/pi-spawn.ts:276`; `noExtensions: true` in the session backend at `src/session-agent.ts:487`) for determinism + isolation. The spec-15 model-inheritance work now passes the parent's full `ctx.model` object to children, but if that model comes from an extension-registered provider (e.g. pi 0.81+ `pi.registerProvider(...)` or a llama.cpp router extension), the child cannot resolve it because the provider is never registered in the child's fresh model runtime — inheritance silently degrades to the settings default. This adds an env-var opt-in `SUPER_DEV_INHERIT_EXTENSIONS` (truthy → enable), defaulting OFF for byte-identical current behavior, that lifts extension suppression in BOTH backends so extension-sourced providers/models become visible to children.

## Acceptance Criteria

- **AC-01**: A new exported helper `inheritExtensions()` lives in `src/pi-spawn.ts` (alongside the existing `SUPER_DEV_MODEL` / `SUPER_DEV_THINKING` / `SUPER_DEV_BACKEND` env reads) and returns `true` ONLY when `process.env.SUPER_DEV_INHERIT_EXTENSIONS` is set to a truthy token — `1`, `true`, `yes`, `on` (case-insensitive, whitespace-trimmed) — and `false` for unset, empty, `0`, `false`, or any unrecognized/garbage value.
- **AC-02**: Subprocess backend: the `buildSpawnArgs` guard at `src/pi-spawn.ts:276` becomes `if (!browser && !inheritExtensions()) args.push("--no-extensions");`. With the opt-in OFF (default), behavior is byte-identical to today (every non-browser agent gets `--no-extensions`); with it ON, non-browser agents OMIT `--no-extensions` so ambient global+project extensions load.
- **AC-03**: Session backend: the `DefaultResourceLoader` construction at `src/session-agent.ts:487` changes `noExtensions: true` to `noExtensions: !inheritExtensions()` (importing `inheritExtensions` from `./pi-spawn.ts`). The safety factory remains in `extensionFactories` either way (unchanged). With the opt-in OFF, byte-identical to today (`noExtensions: true`); ON → `noExtensions: false` loads ambient extensions while the inline safety factory still loads.
- **AC-04**: Browser-agent behavior is unchanged in BOTH opt-in states: browser-capable agents never receive `--no-extensions` (the `!browser` guard already skips them) and the opt-in does not alter that path.
- **AC-05**: Concise trade-off code comments are present at BOTH wiring points (`buildSpawnArgs` guard and the session-backend loader) stating: opting in loses determinism (the child loads ALL user extensions, potentially super-dev itself — though specialists receive no user input so they will not self-trigger the pipeline) and is intended for users whose model stack depends on an extension-registered provider.
- **AC-06**: Focused tests added: (a) a `pi-spawn` test asserting `--no-extensions` IS present for a normal agent when the opt-in is OFF and ABSENT when ON, and that browser agents never get `--no-extensions` regardless of the opt-in; (b) a unit test for `inheritExtensions()` parsing covering truthy (`1`/`true`/`yes`/`on`, mixed case, padded) and falsy (unset, `0`/`false`/empty/garbage). If the session-backend loader construction is isolatable, add a parallel assertion; otherwise the `inheritExtensions()` unit test plus the documented wiring is sufficient.
- **AC-07**: A new `[Unreleased]` CHANGELOG.md `### Added` entry summarizes the opt-in, with its first bullet as a `**bold**` bullet whose text contains one of the changelog-contract-test anchors (`inherit`/`extensions`/`provider`); `tests/changelog-unreleased-spec15.test.ts` stays green (the new entry must not remove or reorder the anchors the test already matches, e.g. `/inherit/i`, `### Added`, the bold-bullet regex, and the preserved prior bullets).
- **AC-08**: `npm run typecheck` is strict-clean and the full `npm test` suite (existing + new) is green against the `^0.82.1` type surface.
- **AC-09**: Non-goals honored: the opt-in defaults OFF (current isolation/determinism never changes unless the env var is explicitly set); the safety factory, the `inheritedModelObject` model-inheritance path, the control-flow node algebra, the resume cache, and the pipeline stage structure are untouched; every existing no-throw/best-effort guard and the print/json/rpc/headless zero-ANSI contract are preserved.

## Non-Functional Requirements

- Isolation/determinism contract: default-OFF means spawned specialists remain in a clean, ambient-extension-free environment unless the user explicitly opts in — a deliberate security/isolation boundary (specialists receive no user input and must not self-trigger the pipeline), preserved byte-identically when the env var is absent or falsy.
- Additive, zero-new-runtime-dependency change; a single env read (`process.env.SUPER_DEV_INHERIT_EXTENSIONS`) with a cheap regex/Boolean parse, no hot-path or I/O impact.
- No-throw/best-effort preserved at both wiring points; an absent or malformed env value degrades cleanly to the current OFF behavior rather than erroring.
- When opted in, specialists lose isolation: they load ALL user-installed global+project extensions (potential blast radius / non-determinism), which is acceptable only because the documented intent is a user-model-stack escape hatch.
- print/json/rpc/headless output stays ZERO-ANSI byte-clean — the change touches no rendering, sink, or transcript path.

## Open Questions

- Should the opt-in also be surfaced as a structured `RunOptions`/config flag (not just an env var) for discoverability, or is the env-var-only escape hatch (consistent with `SUPER_DEV_MODEL`/`SUPER_DEV_THINKING`/`SUPER_DEV_BACKEND`) the agreed scope? Task specifies env-var only — confirmed non-goal unless overridden.
- Should README/`docs/` (e.g. an env-vars reference) be updated to document `SUPER_DEV_INHERIT_EXTENSIONS`, or is the in-code trade-off comment + CHANGELOG entry sufficient? Other `SUPER_DEV_*` vars like `SUPER_DEV_CARGO_METADATA_TIMEOUT_MS` are README-documented, suggesting parity would be consistent.
