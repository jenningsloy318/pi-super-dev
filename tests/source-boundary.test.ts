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
	const qdirs: string[] = [];
	beforeEach(() => { f = makeRepo(); });
	afterEach(() => {
		f?.clean();
		for (const q of qdirs) { try { rmSync(q, { recursive: true, force: true }); } catch { /* best-effort */ } }
	});

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

	it("the porcelain -z R/C arm: a renamed file fingerprints BOTH the old and new path with status R", () => {
		put(f.wt, "old-name.ts", "stable bytes\n");
		execFileSync("git", ["-C", f.wt, "add", "."]);
		execFileSync("git", ["-C", f.wt, "commit", "-m", "seed"]);
		const { before, after } = captureAround(f.wt, () => {
			execFileSync("git", ["-C", f.wt, "mv", "old-name.ts", "new-name.ts"]);
		});
		// the R record consumes TWO -z fields (old + new); a transcription slip
		// (parts[i] vs parts[++i]) silently drops the second path from the map
		expect(after.fingerprints.get("old-name.ts")?.status.startsWith("R")).toBe(true); // "R " — the two-char code
		expect(after.fingerprints.get("new-name.ts")?.status.startsWith("R")).toBe(true);
		// identical content means sameFingerprint sees matching hashes — but the
		// OLD path vanishes from a clean tree's map, so the pair IS a violation set
		expect(sourceBoundaryViolations(before, after)).toEqual(["new-name.ts", "old-name.ts"]);
	});

	it("the :(literal) guard: the S2 incident filename `:(top)*` restores ONLY itself — a guard-less run reverts the WHOLE worktree", () => {
		// The S2 incident shape (docs/methodology/05-findings-2026-09-01.md): without
		// :(literal), `:(top)*` parses as top-magic + glob-* = EVERY root file — the
		// innocent file's reversion is the DIRECT discriminator, not belt-and-suspenders.
		writeFileSync(join(f.wt, ":(top)*"), "evil v1\n");
		writeFileSync(join(f.wt, "innocent.txt"), "innocent v1\n");
		execFileSync("git", ["-C", f.wt, "add", "."]);
		execFileSync("git", ["-C", f.wt, "commit", "-m", "seed"]);
		const { before, after } = captureAround(f.wt, () => {
			writeFileSync(join(f.wt, ":(top)*"), "evil v2\n");
			writeFileSync(join(f.wt, "innocent.txt"), "innocent v2\n"); // a concurrent writer's legit edit
		});
		const out = restoreNewSourceViolations(f.wt, before, after, [":(top)*"], null, "restore");
		expect(out.restored).toEqual([":(top)*"]);
		expect(readFileSync(join(f.wt, ":(top)*"), "utf8")).toBe("evil v1\n");
		expect(readFileSync(join(f.wt, "innocent.txt"), "utf8")).toBe("innocent v2\n"); // untouched — the worktree-wide revert class is pinned HERE
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
		qdirs.push(qdir);
		const out = restoreNewSourceViolations(f.wt, before, after, ["violation.txt", "planted-link"], qdir, "quarantine");
		expect(out.restored).toEqual([]);
		expect(out.quarantined).toEqual(["violation.txt"]); // the symlink is NOT copied
		expect(existsSync(join(f.wt, "violation.txt"))).toBe(true); // nothing mutated in quarantine mode
		const files = readdirSync(qdir);
		expect(files.some((n) => n.endsWith("violation.txt"))).toBe(true);
		expect((statSync(qdir).mode & 0o777)).toBe(0o700);
		expect(readFileSync(join(qdir, files.find((n) => n.endsWith("violation.txt"))!), "utf8")).toBe("violating bytes\n");
	});
});
