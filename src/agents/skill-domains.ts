/**
 * v0.3.76 L1 — the skill-domain catalog, ISOLATED as a zero-import leaf
 * module on purpose.
 *
 * This data is consumed by BOTH src/prompts.ts (classifier prompt block) and
 * src/agents/agent-runtime.ts (skillsForCall). It must NOT live in
 * agent-runtime: prompts.ts is imported across stages/render/replan, and an
 * edge prompts → agent-runtime (which transitively pulls setup/resume/
 * knowledge/user-notes) perturbs the vitest module-init order so badly that
 * v8 coverage attributes every function in that subtree twice (measured
 * 2026-09-07: functions 1230 → 1467 with +88 real statements, global
 * function coverage 95.04 → 80.09 — the coverage gate failed on phantom
 * duplicate entries). A leaf module keeps the import graph acyclic in the
 * direction that matters and the coverage honest.
 */

/** L0: engine-initiated mechanical classifier roles (see agent-runtime for
 * the full rationale — measured 0 real skill usage; `skill:false`). */
export const MECHANICAL_CLASSIFIER_ROLES = new Set([
	"task-classifier",
	"judge",
	"tdd-coverage-classifier",
	"red-boundary-classifier",
]);

/** The approved curated set for research/web roles (user 2026-09-07:
 * "研究全家桶") — the firecrawl family, the only skill family with a measured
 * real-use event. Grows via the L2 telemetry loop, not by guessing. */
export const DEFAULT_RESEARCH_SKILLS = [
	"firecrawl",
	"firecrawl-search",
	"firecrawl-crawl",
	"firecrawl-scrape",
	"firecrawl-map",
	"firecrawl-instruct",
	"firecrawl-download",
	"firecrawl-agent",
];

/** L1: the domain catalog — map-driven, NOT a scan of the 149-card ambient
 * listing. The task-classifier sees name + description + members and emits
 * `skillDomains`; the engine unions the mapped member sets into research-role
 * requests. Growing a domain = adding one descriptor here (its prompt block
 * and the request-side union follow automatically). Browser capability rides
 * EXTENSIONS (per-role pi-browser-cdp), so it has no skill domain today. */
export interface SkillDomainDescriptor {
	name: string;
	description: string;
	skills: string[];
}
export const SKILL_DOMAINS: SkillDomainDescriptor[] = [
	{
		name: "web-research",
		description: "the task needs live web search, scraping, crawling, or page interaction (external sources, current data, URLs to fetch)",
		skills: [...DEFAULT_RESEARCH_SKILLS],
	},
];
