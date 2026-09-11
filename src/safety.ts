/**
 * Safety guardrails — host-side re-export surface for the self-contained child
 * extension (src/child-guards/safety-guard.ts).
 *
 * History: this module originally shipped two execution surfaces for the
 * deleted backends — `createSafetyExtensionFactory()` (the in-process session
 * backend's inline `tool_call` hook, loaded into the child session's
 * ResourceLoader alongside `noExtensions: true`) and `safetyPreamble()` (the
 * subprocess backend's soft prompt guardrail). v0.3.64 removed both backends
 * from the production path; v0.3.88 deleted the session backend's bench copy,
 * and with it the factory and the preamble (their only remaining consumers
 * were tests exercising dead seams). Delegated children get the SAME rules
 * through the child-guard extension on `subagentOnlyExtensions` (see
 * src/agents/register-agents.ts), and the host uses the re-exported checkers
 * below (lifecycle.ts service bringup).
 *
 * The denylist + protected-file patterns are ported verbatim from the original
 * plugin's battle-tested hook scripts. Protected-file logic differs in one
 * deliberate way: we block OVERWRITES of existing secret files only, and allow
 * creates (+ always allow `.env.example`) so greenfield scaffolding isn't blocked.
 */

// F-13 (v0.3.86): the denylist/protected-file tables + checkers now live in
// the SELF-CONTAINED child extension (src/child-guards/safety-guard.ts) so the
// SAME rules load inside every delegated child via subagentOnlyExtensions;
// this module re-exports them for host-side consumers (lifecycle.ts service
// bringup; the bench session agent, until v0.3.88 deleted it). Single source
// of truth — no drift.
export { checkBashCommand, checkProtectedWrite } from "./child-guards/safety-guard.ts";
export type { CheckResult } from "./child-guards/safety-guard.ts";
