import { languageDirective } from "../render/super-dev-dir.ts";
import { splitModelThinking, resolveThinking } from "../agents/agent-runtime/index.ts";
import { getRetryFeedback, renderRetryFeedbackBlock } from "../retry-feedback.ts";
import { convergenceRetryFeedback, normalizeConvergenceStage } from "../convergence-ledger.ts";
import { knowledgeForAgent } from "../render/knowledge.ts";
import { appendUserNotes, userNotesForAgent } from "../render/user-notes.ts";
import { recordInstruction } from "../team/messages.ts";
import { drainControlDrift, extractControlKeys } from "../control.ts";
import { ledgerRunId } from "../runlog.ts";
import type { AgentCall, PipelineState, RunOptions } from "../types.ts";

/**
 * Wave 2 increment 6: the agent-call prompt assembly + per-call policy
 * resolution (feedback merge -> autonomy clause -> knowledge injection ->
 * user-notes drain/persist -> access-mode section -> language directive, plus
 * controlKeys/timeout/thinking/model resolution), extracted from realAgent
 * verbatim. One reason to change: agent prompt + dispatch policy.
 */
/** v0.3.35: prepended to EVERY delegation prompt — see realAgent. */
export const DELEGATION_AUTONOMY_CLAUSE = "## Autonomy (hard constraint)\nYou run AUTONOMOUSLY — there is no human and no supervisor watching, and nobody will answer a question. NEVER call intercom, subagent_supervisor, or subagent_wait, and never wait for a reply. If you are blocked or missing information, complete everything you CAN and state the blocker plainly in your final structured output.";

export interface AgentCallAssembly {
	/** The pre-language prompt (access-mode section applied) — the start log reads its length. */
	promptWithAccess: string;
	/** The final prompt (language directive last). */
	promptWithLanguage: string;
	/** The stage key (pipeline. stripped) — the terminal ledger rows read it. */
	stageKey: string;
	controlKeys: string[];
	allowEmptyArraysFor: string[] | undefined;
	timeoutMs: number | undefined;
	timeoutLabel: string;
	perCallThinking: string | undefined;
	thinkingLabel: string;
	accessMode: AgentCall["accessMode"];
	inheritedModel: string | undefined;
}

export function assembleAgentCall(
	call: AgentCall,
	state: PipelineState,
	options: RunOptions,
	log: (m: string) => void,
): AgentCallAssembly {
		// First-principles retry convergence: if a gate rejected a prior attempt,
		// it stored structured errors under state.__feedback[stageId]. Prepend them
		// to this attempt's prompt so the agent fixes the specific failure instead
		// of resampling the same distribution. The writer's call.id is `pipeline.<id>`.
		const stageKey = (call.id ?? "").replace(/^pipeline\./, "");
		const feedback = getRetryFeedback(state as Record<string, unknown>, stageKey) ?? [];
		const alreadyHasLedger = feedback.some((item) => typeof item === "object" && item !== null && "location" in item && String((item as { location?: unknown }).location ?? "").startsWith("convergence-ledger/"));
		const ledgerFeedback = alreadyHasLedger ? [] : convergenceRetryFeedback(state, { stage: stageKey || call.agent, currentStage: normalizeConvergenceStage(stageKey, "implementation"), gate: "convergence-ledger" });
		const combinedFeedback = [...feedback, ...ledgerFeedback];
		const feedbackBlock = combinedFeedback.length ? renderRetryFeedbackBlock(combinedFeedback) : "";
	// v0.3.35: AUTONOMY CLAUSE on every delegation. Runs 2026-08-30T04-53-26 /
		// 05-26-19: specialists occasionally "ask a supervisor" mid-task
		// (intercom/subagent_supervisor) — pi-subagents DETACHES such a child and
		// the whole multi-minute turn is discarded (observed on
		// sd-requirements-clarifier and sd-debug-analyzer; each detach cost a full
		// convergence round). No supervisor exists: state it up front.
		const autonomy = DELEGATION_AUTONOMY_CLAUSE;
		const prompt = combinedFeedback.length
			? `${call.prompt}\n\n${autonomy}\n\n${feedbackBlock}\nRe-produce the complete artifact, then call structured_output.`
			: `${call.prompt}\n\n${autonomy}`;
		// Option C: inject ONLY the fields this agent needs from prior stages'
		// structured_output (control objects), extracted from .knowledge.json.
		const knowledge = knowledgeForAgent(state.setup?.specDirectory ?? "", call.agent);
		const promptWithKnowledge = knowledge
			? `${prompt}\n\n## Prior-stage data (auto-injected)\n${knowledge}`
			: prompt;
		// Drain captured mid-run user input ONCE per spawn and PERSIST it to
		// `.user-notes.json` (durable, resume-safe). Then inject the ACCUMULATED
		// notes (incl. the just-appended ones) into THIS agent's prompt — so every
		// subsequent stage sees all user context added so far, not just the next
		// agent. Draining here (inside realAgent, not the memoizing wrapper) means a
		// cached/replayed spawn during resume does NOT re-drain. Non-interrupting:
		// a note typed during agent N is picked up at the N+1 boundary.
		const drained = options.userSteerProvider ? options.userSteerProvider() : [];
		appendUserNotes(state.setup?.specDirectory, drained);
		// P3.1: user instructions are ledger events too (the instruction channel
		// of the message bus — folds see what the human injected and when).
		for (const note of drained) recordInstruction(state.setup?.specDirectory, typeof note === "string" ? note : note.text, ledgerRunId(state)); // v0.3.56 F9a: RuntimeInstruction objects rendered as '[object Object]' in the ledger (P10)
		const userNotes = userNotesForAgent(state.setup?.specDirectory);
		const promptWithNotes = userNotes
			? `${promptWithKnowledge}\n\n## User context (added during the run)\n${userNotes}`
			: promptWithKnowledge;
		const controlKeys = call.controlKeys ?? extractControlKeys(call.prompt);
		// v0.3.54 (P10): contract-drift telemetry (unbalanced parens, dropped
		// fragments, F6 fallback acceptances) lands in the RUN LOG with the call
		// id — console.warn never reached run.log/audit, so live runs could not
		// see why a control line misparsed.
		for (const drift of drainControlDrift()) log(`agent ${call.id ?? call.agent}: ${drift}`);
		const allowEmptyArraysFor = call.allowEmptyArraysFor;
		const timeoutMs = call.timeoutMs;
		const timeoutLabel = timeoutMs !== undefined ? `${timeoutMs}ms` : "role-default";
		// v0.3.45: a per-call model may carry a `:level` suffix ("glm-5.3:high");
		// an explicit call.thinking still wins, the suffix fills it when absent
		// (resolveAgentModel strips the suffix from the model string itself).
		const perCallThinking = call.thinking ?? splitModelThinking(call.model).thinking;
		// v0.3.95 FIX B1 (run-2026-09-12T15-16-29-042Z §5.1): the start log prints
		// the SAME resolved value the delegation dispatches — resolveThinking, the
		// one grammar the backend itself calls (P6). The old label chain
		// (perCall ?? inherited ?? SUPER_DEV_THINKING ?? "role-default") was a
		// stale, INCOMPLETE mirror: it missed config.agentThinking[role], the
		// agentModels `:level` suffix, and the role tier, and ordered env AFTER
		// inherited — the operator observed "thinking=max" in the log while the
		// child actually dispatched :high from the config suffix. "role-default"
		// is gone as a label. HONESTY CONTRACT (fix-round ADVISORY-1): the label
		// is the PRE-CLAMP resolved level; when the backend clamps a heuristic
		// source (role tier / inheritance / medium default) against the model's
		// catalog, the delegation clamp notice ("clamped thinking X -> Y …", at
		// least once per provider/model/level per RUN — resetThinkingClampState
		// at runWorkflow start) is the dispatch truth. Computing the clamp HERE
		// was rejected in adjudication: replicating the model-resolution chain
		// across the delegation boundary risks input-shape drift, and a wrong
		// label is worse than a pre-clamp label plus a truthful notice.
		const thinkingLabel = resolveThinking(call.agent, perCallThinking, options.inheritedThinking);
		const accessMode = call.accessMode ?? "write";
		// v0.3.64: the pi-subagents delegation backend is the ONLY specialist
		// backend — browser/web-research roles load their extension tools via the
		// sd-* registration's per-agent `extensions` (agent-runtime.extensionsForAgent,
		// verified live on pi-subagents 0.64 and 0.65 on 2026-09-04), so the old
		// forced-subprocess routing and the session/subprocess backends are gone.
		// options.events (the in-process bus) is a hard requirement: without it a
		// delegation request would hang on an unanswered event — the run-level gate
		// in extension.ts refuses to start, and this seam degrades defensively.
		const inheritedModel = options.inheritedModelObject
			? `${options.inheritedModelObject.provider}/${options.inheritedModelObject.id}`
			: undefined;
		const promptWithAccess = accessMode === "source-read-only"
			? `${promptWithNotes}\n\n## Source mutation boundary\nThis call is source-read-only. You may inspect files and run diagnostics, but do not edit, write, stage, commit, delete, move, or generate files under the project worktree except temporary files outside the repository (for example under /tmp). The super-dev pipeline renders report artifacts for you.`
			: promptWithNotes;
		// v0.3.23: output-language directive rides on EVERY agent call — appended
		// last at THIS seam (the backends may wrap delivery-discipline sections
		// after it, but it stays the final TASK-content section; recency beats
		// system prompts for output language) so every artifact
		// (spec docs, reports, ledger/audit text, commits) lands in the configured
		// language (default english) regardless of the task's language. One choke
		// point covers every agent call; judge calls flow through ctx.agent too.
		const promptWithLanguage = `${promptWithAccess}\n\n${languageDirective()}`;	return { promptWithAccess, promptWithLanguage, stageKey, controlKeys, allowEmptyArraysFor, timeoutMs, timeoutLabel, perCallThinking, thinkingLabel, accessMode, inheritedModel };
}
