/**
 * spec-11 review finding CR-01 (HIGH): the per-run ChangeTracker singleton
 * must actually be INSTALLED in production — `setActiveTracker(new ChangeTracker(...))`
 * in the setup stage. The singleton API + the extension.ts finally-clear were
 * already present, but the CONSTRUCTING CALL was missing, so the entire
 * bracketing + cross-check gate + false-green killer was dead code in real
 * runs. This guard makes that regression visible to CI: a bare import (or a
 * comment describing intent) must NOT satisfy it.
 *
 * Two layers:
 *   1. SOURCE guard — `src/stages/setup.ts` must literally construct + install
 *      a tracker right after `runSetup` finalizes specDirectory/worktreePath.
 *   2. BEHAVIOUR guard — a constructed ChangeTracker is observable via the
 *      singleton, and the execute() finally clears it (no leak across runs).
 *
 * Hermetic: only reads source files + exercises the in-memory singleton.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ChangeTracker, setActiveTracker, getActiveTracker } from "../src/tracking.ts";

/** Read a repo source file as a string for wiring-contract assertions. */
function readSrc(rel: string): string {
	return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("CR-01 — ChangeTracker is installed in production (review HIGH)", () => {
	it("setup stage constructs AND installs a ChangeTracker right after runSetup", () => {
		const src = readSrc("src/stages/setup.ts");
		// The pre-fix regression imported { ChangeTracker, setActiveTracker } but
		// only described the install in a comment — the CALL was missing. This
		// regex requires the actual constructing call with the setup result's
		// `.specDirectory` + `.worktreePath` as args (an import or comment alone
		// cannot satisfy it). `setup` is the runSetup return value.
		expect(
			src,
			"setup stage must call setActiveTracker(new ChangeTracker(<x>.specDirectory, <x>.worktreePath))",
		).toMatch(
			/setActiveTracker\(\s*new\s+ChangeTracker\(\s*[A-Za-z_$][\w$]*\.specDirectory\s*,\s*[A-Za-z_$][\w$]*\.worktreePath\s*\)\s*\)/,
		);
	});

	it("setup stage still imports the lifecycle seam (ChangeTracker + setActiveTracker)", () => {
		const src = readSrc("src/stages/setup.ts");
		expect(src).toMatch(
			/import\s*\{[^}]*\bChangeTracker\b[^}]*\bsetActiveTracker\b[^}]*\}\s*from\s*["']\.\.\/tracking\.ts["']/,
		);
	});

	it("execute()'s finally clears the singleton (no leak across runs)", () => {
		const src = readSrc("src/extension.ts");
		expect(src, "execute finally must setActiveTracker(null)").toMatch(/setActiveTracker\(\s*null\s*\)/);
	});

	it("a freshly constructed ChangeTracker is observable via the singleton (behaviour)", () => {
		setActiveTracker(null);
		expect(getActiveTracker()).toBeNull();
		const t = new ChangeTracker("/tmp/sd-install", "/tmp/sd-install/wt");
		setActiveTracker(t);
		expect(getActiveTracker()).toBe(t);
		// A fresh install discards any stale singleton (the discard guard).
		const fresh = new ChangeTracker("/tmp/sd-install-2", "/tmp/sd-install-2/wt");
		setActiveTracker(fresh);
		expect(getActiveTracker()).toBe(fresh);
		expect(getActiveTracker()).not.toBe(t);
		setActiveTracker(null);
		expect(getActiveTracker()).toBeNull();
	});
});
