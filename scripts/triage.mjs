#!/usr/bin/env node
/**
 * v0.3.69 E3 — FINDING TRIAGE (the human Decide gate).
 *
 * Lists post-mortem drafts in docs/findings/inbox/, lets a human approve or
 * skip each one. Approved drafts move to docs/findings/ with an upgraded
 * status header — from there the existing fix lifecycle (intent → plan → TDD
 * → fix → version) takes over. Zero-LLM by design: the DECISION is human;
 * this script only moves files and rewrites one header line.
 *
 * Usage:
 *   node scripts/triage.mjs [--list]            # list drafts (non-interactive)
 *   node scripts/triage.mjs --approve <file>    # approve one draft by name
 *   node scripts/triage.mjs                     # interactive y/s/q loop
 *   (optional --dir <path> overrides the repo root; tests use it)
 */
import { readdirSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";

const root = process.argv.includes("--dir")
	? process.argv[process.argv.indexOf("--dir") + 1]
	: new URL("..", import.meta.url).pathname;
const inbox = join(root, "docs", "findings", "inbox");
const findings = join(root, "docs", "findings");

function listDrafts() {
	if (!existsSync(inbox)) return [];
	return readdirSync(inbox).filter((f) => f.endsWith(".md")).sort();
}

function titleOf(path) {
	const md = readFileSync(path, "utf8");
	const h1 = md.match(/^#\s+(.+)$/m);
	return h1 ? h1[1] : basename(path);
}

function approve(name) {
	const src = join(inbox, name);
	if (!existsSync(src)) {
		console.error(`no such draft: ${name}`);
		process.exitCode = 1;
		return;
	}
	const md = readFileSync(src, "utf8");
	const approved = md.replace(
		/status: draft( — advisory-only[^\n]*)?/,
		`status: approved (triaged ${new Date().toISOString().slice(0, 10)} — human-approved via E3; fix lifecycle takes over)`,
	);
	mkdirSync(findings, { recursive: true });
	const dest = join(findings, name);
	if (existsSync(dest)) {
		console.error(`refusing to overwrite existing finding: ${name}`);
		process.exitCode = 1;
		return;
	}
	writeFileSync(dest, approved, "utf8");
	rmSync(src, { force: true }); // the approved content IS the move — rename would clobber it
	console.log(`approved → docs/findings/${name}`);
}

if (process.argv.includes("--list")) {
	const drafts = listDrafts();
	if (drafts.length === 0) console.log("(no drafts in docs/findings/inbox/)");
	for (const d of drafts) console.log(`${d} — ${titleOf(join(inbox, d))}`);
	process.exit(0);
}

if (process.argv.includes("--approve")) {
	approve(process.argv[process.argv.indexOf("--approve") + 1]);
	process.exit(process.exitCode ?? 0);
}

// Interactive loop (thin; the logic above is what tests pin).
const drafts = listDrafts();
if (drafts.length === 0) {
	console.log("(no drafts in docs/findings/inbox/)");
	process.exit(0);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));
for (const d of drafts) {
	console.log(`\n— ${d}\n  ${titleOf(join(inbox, d))}`);
	const a = (await ask("  approve? [y]es / [s]kip / [q]uit: ")).trim().toLowerCase();
	if (a === "q") break;
	if (a === "y") approve(d);
}
rl.close();
