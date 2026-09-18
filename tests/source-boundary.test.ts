import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { captureSourceBoundary, restoreNewSourceViolations, sourceBoundaryViolations, type SourceBoundarySnapshot } from "../src/workflow/source-boundary.ts";

function makeRepo(): { wt: string; clean: () => void } {
	const wt = mkdtempSync(join(tmpdir(), "w2i1-boundary-"));
	const git = (args: string[]) => execFileSync("git", ["-C", wt, ...args], { encoding: "utf8" });
	git(["init", "-b", "main"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	mkdirSync(join(wt, "src"), { recursive: true });
writeFileSync(join(wt, "src/app.ts"), "export const A = 1;\n");
	git(["add", "."]);
	git(["commit", "-m", "init"]);
	return { wt, clean: () => rmSync(wt, { recursive: true, force: true }) };
}

/** Write a file, creating parent dirs. */
function put(wt: string, rel: string, content: string): void {
	const full = join(wt, rel);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
}

/** A before/after pair built from real captures, with an edit between. */
function captureAround(wt: string, edit: () => void): { before: SourceBoundarySnapshot; after: SourceBoundarySnapshot } {
	const before = captureSourceBoundary(wt);
	edit();
	const after = captureSourceBoundary(wt);
	return { before, after };
}

describe("workflow/source-boundary — wave 2 increment 1 (capture → compare → restore/quarantine)", () => {
	let f: { wt: string; clean: () => void };
	beforeEach(() => { f = makeRepo(); });
	afterEach(() => f?.clean());

	it("capture fingerprints the dirt: an untracked file gets status ??, kind file, a sha256 hash", () => {
		put(f.wt, "notes/new.md", "hello\n");
		const snap = captureSourceBoundary(f.wt);
		expect(snap.ok).toBe(true);
		const fp = snap.fingerprints.get("notes/new.md");
		expect(fp).toMatchObject({ status: "??", exists: true, kind: "file" });
		expect(fp?.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("capture honors the spec-directory allowlist: dirt under the allowed root is NOT fingerprinted", () => {
		put(f.wt, "docs/spec/report.md", "generated\n");
		const snap = captureSourceBoundary(f.wt, join(f.wt, "docs/spec"));
		expect(snap.fingerprints.has("docs/spec/report.md")).toBe(false);
		expect(snap.allowedRoots).toEqual([join(f.wt, "docs/spec")]);
		// without the allowlist the same dirt IS fingerprinted
		const bare = captureSourceBoundary(f.wt);
		expect(bare.fingerprints.has("docs/spec/report.md")).toBe(true);
	});

	it("capture degrades to ok:false on git failure (empty fingerprints, honest error)", () => {
		const broken = captureSourceBoundary("/nonexistent/w2i1-repo");
		expect(broken.ok).toBe(false);
		expect(broken.fingerprints.size).toBe(0);
		expect(broken.error).toBeTruthy();
	});

	it("a tracked file replaced BY a directory fingerprints as kind dir", () => {
		put(f.wt, "gate", "file bytes\n");
		execFileSync("git", ["-C", f.wt, "add", "."]);
		execFileSync("git", ["-C", f.wt, "commit", "-m", "seed"]);
		const { after } = captureAround(f.wt, () => {
			rmSync(join(f.wt, "gate"));
			mkdirSync(join(f.wt, "gate"), { recursive: true });
			put(f.wt, "gate/inner.txt", "x\n");
		});
		expect(after.fingerprints.get("gate")).toMatchObject({ exists: true, kind: "dir" });
	});

	it("violations diff: new, modified (hash change), and deleted paths — sorted, unchanged excluded", () => {
		writeFileSync(join(f.wt, "tracked-keep.txt"), "keep\n");
		writeFileSync(join(f.wt, "tracked-mod.txt"), "v1\n");
		writeFileSync(join(f.wt, "gone.txt"), "v1\n");
		execFileSync("git", ["-C", f.wt, "add", "."]);
		execFileSync("git", ["-C", f.wt, "commit", "-m", "seed"]);
		const { before, after } = captureAround(f.wt, () => {
			writeFileSync(join(f.wt, "brand-new.txt"), "n\n");
			writeFileSync(join(f.wt, "tracked-mod.txt"), "v2 CHANGED\n");
			rmSync(join(f.wt, "gone.txt"));
		});
		const violations = sourceBoundaryViolations(before, after);
		expect(violations).toEqual(["brand-new.txt", "gone.txt", "tracked-mod.txt"]); // sorted
		expect(violations).not.toContain("tracked-keep.txt");
	});

	it("restore mode: untracked violation REMOVED, tracked-modified REVERTED via git (byte-identical to HEAD)", () => {
		writeFileSync(join(f.wt, "tracked-mod.txt"), "v1\n");
		execFileSync("git", ["-C", f.wt, "add", "."]);
		execFileSync("git", ["-C", f.wt, "commit", "-m", "seed"]);
		const { before, after } = captureAround(f.wt, () => {
			writeFileSync(join(f.wt, "tracked-mod.txt"), "v2 CHANGED\n");
			writeFileSync(join(f.wt, "untracked-new.ts"), "export const X = 1;\n");
		});
		const violations = sourceBoundaryViolations(before, after);
		const out = restoreNewSourceViolations(f.wt, before, after, violations, null, "restore");
		expect(out.restored.sort()).toEqual(["tracked-mod.txt", "untracked-new.ts"]);
		expect(out.manual).toEqual([]);
		expect(existsSync(join(f.wt, "untracked-new.ts"))).toBe(false);
		expect(readFileSync(join(f.wt, "tracked-mod.txt"), "utf8")).toBe("v1\n"); // reverted to HEAD bytes
	});

	it("restore mode: a path present in the BEFORE snapshot is manual (never blindly restored)", () => {
		writeFileSync(join(f.wt, "pre.txt"), "pre\n");
		const before = captureSourceBoundary(f.wt);
		writeFileSync(join(f.wt, "pre.txt"), "pre CHANGED\n"); // dirt that predates the agent call
		const after = captureSourceBoundary(f.wt);
		const out = restoreNewSourceViolations(f.wt, before, after, ["pre.txt"], null, "restore");
		expect(out.manual).toEqual(["pre.txt"]);
		expect(out.restored).toEqual([]);
		expect(readFileSync(join(f.wt, "pre.txt"), "utf8")).toBe("pre CHANGED\n"); // untouched
	});

	it("the :(literal) guard: a file named with pathspec magic restores ONLY itself (never worktree-wide)", () => {
		writeFileSync(join(f.wt, ":(top)evil.txt"), "evil v1\n");
		writeFileSync(join(f.wt, "innocent.txt"), "innocent v1\n");
		execFileSync("git", ["-C", f.wt, "add", "."]);
		execFileSync("git", ["-C", f.wt, "commit", "-m", "seed"]);
		const { before, after } = captureAround(f.wt, () => {
			writeFileSync(join(f.wt, ":(top)evil.txt"), "evil v2\n");
			writeFileSync(join(f.wt, "innocent.txt"), "innocent v2\n"); // a concurrent writer's legit edit
		});
		const out = restoreNewSourceViolations(f.wt, before, after, [":(top)evil.txt"], null, "restore");
		expect(out.restored).toEqual([":(top)evil.txt"]);
		expect(readFileSync(join(f.wt, ":(top)evil.txt"), "utf8")).toBe("evil v1\n");
		expect(readFileSync(join(f.wt, "innocent.txt"), "utf8")).toBe("innocent v2\n"); // untouched
	});

	it("quarantine mode: NOTHING restored, bytes copied (0o700 dir), planted symlinks skipped", () => {
		writeFileSync(join(f.wt, "target.txt"), "the target bytes\n");
		execFileSync("git", ["-C", f.wt, "add", "."]);
		execFileSync("git", ["-C", f.wt, "commit", "-m", "seed"]);
		const { before, after } = captureAround(f.wt, () => {
			writeFileSync(join(f.wt, "violation.txt"), "violating bytes\n");
			symlinkSync(join(f.wt, "target.txt"), join(f.wt, "planted-link"));
		});
		const qdir = join(f.wt, "..", `sd-boundary-test-${Date.now()}`);
		const out = restoreNewSourceViolations(f.wt, before, after, ["violation.txt", "planted-link"], qdir, "quarantine");
		expect(out.restored).toEqual([]);
		expect(out.quarantined).toEqual(["violation.txt"]); // the symlink is NOT copied
		expect(existsSync(join(f.wt, "violation.txt"))).toBe(true); // nothing mutated in quarantine mode
		const files = readdirSync(qdir);
		expect(files.some((n) => n.endsWith("violation.txt"))).toBe(true);
		expect((statSync(qdir).mode & 0o777)).toBe(0o700);
		expect(readFileSync(join(qdir, files.find((n) => n.endsWith("violation.txt"))!), "utf8")).toBe("violating bytes\n");
		rmSync(qdir, { recursive: true, force: true });
	});
});
