import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { checkServingFreshness, servingVersionLine } from "../src/serving-freshness.ts";

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** Build a clone whose origin/main is N commits ahead of the clone's HEAD. */
function mkStaleClone(commitsAhead: number): { clone: string; clean: () => void } {
	const root = mkdtempSync(join(tmpdir(), "fresh-"));
	const origin = join(root, "origin.git");
	const clone = join(root, "clone");
	execFileSync("git", ["init", "--bare", "-b", "main", origin], { encoding: "utf8" });
	const seed = join(root, "seed");
	mkdirSync(seed);
	execFileSync("git", ["-C", seed, "init", "-b", "main"], { encoding: "utf8" });
	// review code-F1: repo-local identity — identity-less CI runners would fail
	// every commit here (the flake class Wave C exists to eliminate).
	git(seed, "config", "user.email", "t@t");
	git(seed, "config", "user.name", "t");
	writeFileSync(join(seed, "a.txt"), "seed\n");
	git(seed, "add", "-A");
	execFileSync("git", ["-C", seed, "commit", "-m", "seed", "--no-gpg-sign"], { encoding: "utf8" });
	execFileSync("git", ["-C", seed, "remote", "add", "origin", origin], { encoding: "utf8" });
	git(seed, "push", "-q", "origin", "main");
	execFileSync("git", ["clone", origin, clone], { encoding: "utf8" });
	// advance origin/main on the seed side (the clone stays behind)
	for (let i = 0; i < commitsAhead; i++) {
		writeFileSync(join(seed, `f${i}.txt`), `advance ${i}\n`);
		git(seed, "add", "-A");
		execFileSync("git", ["-C", seed, "commit", "-m", `advance ${i}`, "--no-gpg-sign"], { encoding: "utf8" });
	}
	git(seed, "push", "-q", "origin", "main");
	return { clone, clean: () => rmSync(root, { recursive: true, force: true }) };
}

describe("v0.3.81 C1 — serving-copy freshness", () => {
	// The suite-wide hermeticity guard (tests/setup/config-env-hermeticity.ts)
	// short-circuits the real fetch; the git-fixture tests below opt back in
	// (local bare origins — no network) and restore the guard afterwards.
	let guardSaved: string | undefined;
	let guardWasSet = false;
	beforeAll(() => {
		guardSaved = process.env.SUPER_DEV_NO_FRESHNESS_CHECK;
		guardWasSet = guardSaved !== undefined;
		delete process.env.SUPER_DEV_NO_FRESHNESS_CHECK;
	});
	afterAll(() => {
		if (guardWasSet) process.env.SUPER_DEV_NO_FRESHNESS_CHECK = guardSaved;
		else delete process.env.SUPER_DEV_NO_FRESHNESS_CHECK;
	});

	it("servingVersionLine stamps the version label", () => {
		expect(servingVersionLine()).toMatch(/super-dev v\d+\.\d+\.\d+ serving/);
	});

	it("a non-git extension dir resolves silently (no warn)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fresh-ng-"));
		try {
			const warns: string[] = [];
			const out = await checkServingFreshness(dir, (line) => warns.push(line));
			expect(out.staleCommits).toBe(0);
			expect(warns).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("a clone behind origin/main warns with the count and the update remedy", async () => {
		const { clone, clean } = mkStaleClone(2);
		try {
			const warns: string[] = [];
			const out = await checkServingFreshness(clone, (line) => warns.push(line));
			expect(out.staleCommits).toBe(2);
			expect(warns.join("\n")).toContain("2 commit(s) behind origin/main");
			expect(warns.join("\n")).toMatch(/git pull|restart pi/);
		} finally {
			clean();
		}
	}, 45_000);

	it("an up-to-date clone resolves without warning", async () => {
		const { clone, clean } = mkStaleClone(0);
		try {
			const warns: string[] = [];
			const out = await checkServingFreshness(clone, (line) => warns.push(line));
			expect(out.staleCommits).toBe(0);
			expect(warns).toHaveLength(0);
		} finally {
			clean();
		}
	}, 45_000);

	it("review pin: SUPER_DEV_NO_FRESHNESS_CHECK=1 short-circuits with zero git invocations (suite hermeticity guard)", async () => {
		const before = process.env.SUPER_DEV_NO_FRESHNESS_CHECK;
		process.env.SUPER_DEV_NO_FRESHNESS_CHECK = "1";
		try {
			const warns: string[] = [];
			const out = await checkServingFreshness("/definitely-not-a-repo", (line) => warns.push(line));
			expect(out).toEqual({ staleCommits: 0 });
			expect(warns).toHaveLength(0);
		} finally {
			if (before === undefined) delete process.env.SUPER_DEV_NO_FRESHNESS_CHECK;
			else process.env.SUPER_DEV_NO_FRESHNESS_CHECK = before;
		}
	});

	it("checkServingFreshness never rejects (all failures degrade to silent)", async () => {
		await expect(checkServingFreshness("/nonexistent-dir-xyz", () => {})).resolves.toEqual({ staleCommits: 0 });
	}, 30_000);
});
