/**
 * v0.3.56 F4 — agent-STAGED changes survived discard: `git checkout --` /
 * `git restore --worktree` leave the INDEX untouched, so staged content stayed
 * in both index and worktree after RED cleanup / GREEN discard
 * (attributQuarantinedViolations already used --staged --worktree — the
 * inconsistent restore class).
 *
 * Escape class B/C (restore-family grammar + shared-file restore interactions,
 * docs/methodology/02-design.md §4); defense layer L4 (real git repo,
 * docs/testing-strategy.md).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { discardGreenWork, restorePaths } from "../src/stages/implementation.ts";

function git(cwd: string, ...args: string[]): string {
	return execSync(`git ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, { cwd, encoding: "utf8" });
}

/** Real temp repo with a committed baseline file. */
function makeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "sd-f4-discard-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "t@t");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "tracked.txt"), "base\n");
	git(root, "add", ".");
	git(root, "commit", "-qm", "base");
	return root;
}

describe("discardGreenWork — staged changes are fully discarded (F4)", () => {
	it("a staged MODIFICATION reverts in BOTH index and worktree", () => {
		const root = makeRepo();
		try {
			writeFileSync(join(root, "tracked.txt"), "agent edit\n");
			git(root, "add", "tracked.txt");
			const restored = discardGreenWork(root, new Set());
			expect(restored).toContain("tracked.txt");
			expect(git(root, "status", "--porcelain")).toBe(""); // index AND worktree clean
			expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("base\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("a staged-NEW file is removed entirely (unstaged + cleaned)", () => {
		const root = makeRepo();
		try {
			writeFileSync(join(root, "staged-new.ts"), "new module\n");
			git(root, "add", "staged-new.ts");
			discardGreenWork(root, new Set());
			expect(git(root, "status", "--porcelain")).toBe("");
			expect(existsSync(join(root, "staged-new.ts"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("keep-set test files survive the discard (RED-hijack guard intact)", () => {
		const root = makeRepo();
		try {
			mkdirSync(join(root, "tests"));
			writeFileSync(join(root, "tests", "red.test.mjs"), "import test from 'node:test';\ntest('red', () => { throw new Error('x'); });\n");
			discardGreenWork(root, new Set(["tests/red.test.mjs"]));
			expect(existsSync(join(root, "tests", "red.test.mjs"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("restore-class parity — attributQuarantinedViolations vs discardGreenWork (F4)", () => {
	it("both fully revert a staged modification (same end state)", async () => {
		// attributQuarantinedViolations takes the structured BoundaryQuarantinePayload
		// (v0.3.55 contract) + the implementer control; drive it with a real payload.
		const { attributQuarantinedViolations } = await import("../src/stages/implementation.ts");
		const makeStaged = (): string => {
			const root = makeRepo();
			writeFileSync(join(root, "tracked.txt"), "changed\n");
			git(root, "add", "tracked.txt");
			return root;
		};
		const a = makeStaged();
		const b = makeStaged();
		try {
			const log: string[] = [];
			attributQuarantinedViolations(
				a,
				{ violations: ["tracked.txt"], dir: join(a, ".quarantine") },
				{ filesCreated: [], filesModified: ["unrelated.txt"], filesDeleted: [] }, // declared ≠ violated → restore fires
				[],
				(l) => log.push(l),
			);
			discardGreenWork(b, new Set());
			expect(git(a, "status", "--porcelain")).toBe("");
			expect(git(b, "status", "--porcelain")).toBe("");
			expect(readFileSync(join(a, "tracked.txt"), "utf8")).toBe(readFileSync(join(b, "tracked.txt"), "utf8"));
		} finally {
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	});
});

describe("restorePaths — :(literal) magic-name pin (F9f, v0.3.55 residual)", () => {
	it("a file literally named ':(top)*' is restored literally, never as a top glob", () => {
		const root = makeRepo();
		try {
			mkdirSync(join(root, "sub"));
			writeFileSync(join(root, "sub", "innocent.txt"), "base\n");
			git(root, "add", ".");
			git(root, "commit", "-qm", "sub");
			// Dirt the restore must NOT touch, plus the magic-named file it must.
			writeFileSync(join(root, "sub", "innocent.txt"), "modified\n");
			writeFileSync(join(root, ":(top)*"), "magic file\n");
			restorePaths(root, [":(top)*"]);
			// Pre-fix, ':(top)*' was a magic pathspec (top-level glob '*'): the
			// clean/restore would have widened to the WHOLE worktree and reverted
			// sub/innocent.txt. With :(literal) only the magic file is removed.
			expect(existsSync(join(root, ":(top)*"))).toBe(false);
			expect(readFileSync(join(root, "sub", "innocent.txt"), "utf8")).toBe("modified\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
