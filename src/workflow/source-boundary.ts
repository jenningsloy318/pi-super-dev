import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** The source-read-only enforcement pair (wave 2 increment 1, extracted from
 *  workflow.ts verbatim): capture → compare → restore/quarantine. One reason to
 *  change: the boundary semantics themselves. */

export interface PathFingerprint {
	status: string;
	exists: boolean;
	kind: "file" | "dir" | "other" | "missing";
	hash?: string;
}

export interface SourceBoundarySnapshot {
	ok: boolean;
	fingerprints: Map<string, PathFingerprint>;
	allowedRoots: string[];
	error?: string;
}

function normalizeRelPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isInsidePath(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function allowedSourceReadOnlyRoots(cwd: string, specDirectory?: string): string[] {
	const roots: string[] = [];
	if (specDirectory) {
		const abs = resolve(specDirectory);
		if (isInsidePath(abs, resolve(cwd))) roots.push(abs);
	}
	return roots;
}

function isAllowedSourceReadOnlyPath(cwd: string, allowedRoots: string[], relPath: string): boolean {
	const abs = resolve(cwd, relPath);
	return allowedRoots.some((root) => abs === root || abs.startsWith(`${root}${sep}`));
}

function gitStatusEntries(cwd: string): { entries: Map<string, string>; error?: string } {
	const r = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, encoding: "utf8" });
	if (r.error) return { entries: new Map(), error: r.error.message };
	if (r.status !== 0) return { entries: new Map(), error: (r.stderr || r.stdout || `git status exited ${r.status}`).trim() };
	const entries = new Map<string, string>();
	const parts = r.stdout.split("\0").filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i];
		if (rec.length < 4) continue;
		const status = rec.slice(0, 2);
		const path = normalizeRelPath(rec.slice(3));
		entries.set(path, status);
		if ((status[0] === "R" || status[0] === "C") && i + 1 < parts.length) {
			entries.set(normalizeRelPath(parts[++i]), status);
		}
	}
	return { entries };
}

function fingerprintPath(cwd: string, relPath: string, status: string): PathFingerprint {
	const abs = resolve(cwd, relPath);
	try {
		if (!existsSync(abs)) return { status, exists: false, kind: "missing" };
		const st = lstatSync(abs);
		if (st.isDirectory()) return { status, exists: true, kind: "dir" };
		if (!st.isFile() && !st.isSymbolicLink()) return { status, exists: true, kind: "other" };
		const hash = createHash("sha256").update(readFileSync(abs)).digest("hex");
		return { status, exists: true, kind: "file", hash };
	} catch {
		return { status, exists: existsSync(abs), kind: "other" };
	}
}

export function captureSourceBoundary(cwd: string, specDirectory?: string): SourceBoundarySnapshot {
	const allowedRoots = allowedSourceReadOnlyRoots(cwd, specDirectory);
	const { entries, error } = gitStatusEntries(cwd);
	if (error) return { ok: false, fingerprints: new Map(), allowedRoots, error };
	const fingerprints = new Map<string, PathFingerprint>();
	for (const [relPath, status] of entries) {
		if (isAllowedSourceReadOnlyPath(cwd, allowedRoots, relPath)) continue;
		fingerprints.set(relPath, fingerprintPath(cwd, relPath, status));
	}
	return { ok: true, fingerprints, allowedRoots };
}

function sameFingerprint(a: PathFingerprint | undefined, b: PathFingerprint | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function sourceBoundaryViolations(before: SourceBoundarySnapshot, after: SourceBoundarySnapshot): string[] {
	const paths = new Set([...before.fingerprints.keys(), ...after.fingerprints.keys()]);
	return [...paths].filter((path) => !sameFingerprint(before.fingerprints.get(path), after.fingerprints.get(path))).sort();
}

/** v0.3.56 F9f: exported (seam) so tests can drive the quarantine path
 *  directly — captureSourceBoundary/restoreNewSourceViolations are the
 *  source-read-only enforcement pair; tests pin the :(literal) guard and the
 *  symlink skip here. */
export function restoreNewSourceViolations(cwd: string, before: SourceBoundarySnapshot, after: SourceBoundarySnapshot, paths: string[], quarantineDir: string | null, mode: "restore" | "quarantine" = "restore"): { restored: string[]; manual: string[]; quarantined: string[] } {
	const restored: string[] = [];
	const manual: string[] = [];
	const quarantined: string[] = [];
	for (const relPath of paths) {
		// v0.3.54: quarantine the violating content BEFORE any mutation so the
		// evidence survives every downstream branch (P10 — honest evidence trail).
		if (quarantineDir) {
			try {
				const abs0 = resolve(cwd, relPath);
				// v0.3.55 security review F5: lstat (not stat) — a planted symlink
				// must not pull its TARGET's bytes into the quarantine dir; the
				// link itself stays in the worktree as evidence (quarantine mode
				// mutates nothing).
				const st = lstatSync(abs0);
				if (st.isFile()) {
					const safeName = relPath.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "file";
					// v0.3.55 security review F5: 0o700 — same-uid agents had worktree
					// read access anyway; other local users need none.
					mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
					const dest = join(quarantineDir, `${quarantined.length}-${safeName}`);
					copyFileSync(abs0, dest);
					// v0.3.57 review: re-lstat NARROWS the lstat→copy TOCTOU — it
					// cannot close one (a swap between copy and re-check, or a
					// delete, still races). The re-check therefore runs in its own
					// try/catch: ANY failure drops the copy, so the source being
					// deleted mid-race can never strand an orphaned copy with no
					// quarantined[] evidence row (integrity over availability).
					try {
						if (lstatSync(abs0).isFile()) {
							quarantined.push(relPath);
						} else {
							try { rmSync(dest, { force: true }); } catch { /* best-effort */ }
						}
					} catch {
						try { rmSync(dest, { force: true }); } catch { /* best-effort */ }
					}
				}
			} catch { /* quarantine is best-effort; enforcement continues */ }
		}
		if (mode === "quarantine") continue; // v0.3.54: preserve bytes, change nothing
		if (before.fingerprints.has(relPath)) {
			manual.push(relPath);
			continue;
		}
		const fp = after.fingerprints.get(relPath);
		if (!fp) continue;
		const abs = resolve(cwd, relPath);
		if (!isInsidePath(abs, resolve(cwd))) {
			manual.push(relPath);
			continue;
		}
		try {
			if (fp.status === "??") {
				rmSync(abs, { recursive: true, force: true });
				restored.push(relPath);
				continue;
			}
			// v0.3.55 security review F2: `--` ends option parsing but NOT pathspec
			// magic — a file literally named `:(top)*` widens this restore to a
			// worktree-wide revert. Same `:(literal)` guard fault-classification.ts
			// already applies to stash pathspecs.
			const literal = `:(literal)${relPath}`;
			let r = spawnSync("git", ["restore", "--staged", "--worktree", "--", literal], { cwd, encoding: "utf8" });
			if (r.status !== 0) r = spawnSync("git", ["checkout", "--", literal], { cwd, encoding: "utf8" });
			if (r.status === 0) restored.push(relPath);
			else manual.push(relPath);
		} catch {
			manual.push(relPath);
		}
	}
	return { restored, manual, quarantined };
}
