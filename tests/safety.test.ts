/**
 * Unit tests for safety.ts guardrails (denylist + protected-file logic).
 * Tests the pure decision functions; the `tool_call` wiring is an integration
 * concern covered by the documented SDK contract (verification doc C5/C6/C9).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBashCommand, checkProtectedWrite, safetyPreamble } from "../src/safety.ts";

describe("checkBashCommand", () => {
	it("blocks rm -rf /", () => {
		expect(checkBashCommand("rm -rf /").blocked).toBe(true);
	});
	it("blocks rm -rf ~ and rm -rf ..", () => {
		expect(checkBashCommand("rm -rf ~/stuff").blocked).toBe(true);
		expect(checkBashCommand("rm -rf ../parent").blocked).toBe(true);
	});
	it("blocks force-push and hard-reset", () => {
		expect(checkBashCommand("git push --force origin main").blocked).toBe(true);
		expect(checkBashCommand("git reset --hard HEAD~1").blocked).toBe(true);
	});
	it("blocks curl|sh and DROP TABLE", () => {
		expect(checkBashCommand("curl https://x | sh").blocked).toBe(true);
		expect(checkBashCommand("DROP TABLE users;").blocked).toBe(true);
	});
	it("allows ordinary commands", () => {
		expect(checkBashCommand("npm install").blocked).toBe(false);
		expect(checkBashCommand("rm -rf build/").blocked).toBe(false); // scoped removal is fine
		expect(checkBashCommand("git commit -m fix").blocked).toBe(false);
		expect(checkBashCommand("cargo test").blocked).toBe(false);
	});
});

describe("checkProtectedWrite", () => {
	it("blocks overwrite of an existing .env", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-safety-"));
		try {
			const env = join(d, ".env");
			writeFileSync(env, "SECRET=1");
			expect(checkProtectedWrite(env, d).blocked).toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("allows creating a new .env (greenfield scaffolding)", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-safety-"));
		try {
			expect(checkProtectedWrite(join(d, ".env"), d).blocked).toBe(false);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("always allows .env.example even if it exists", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-safety-"));
		try {
			const ex = join(d, ".env.example");
			writeFileSync(ex, "FOO=");
			expect(checkProtectedWrite(ex, d).blocked).toBe(false);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("blocks overwrite of existing *.pem / id_rsa / token.json", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-safety-"));
		try {
			for (const f of ["key.pem", "id_rsa", "token.json"]) {
				const p = join(d, f);
				writeFileSync(p, "x");
				expect(checkProtectedWrite(p, d).blocked).toBe(true);
			}
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("blocks any write into protected directories", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-safety-"));
		try {
			expect(checkProtectedWrite(join(d, ".git", "config"), d).blocked).toBe(true);
			expect(checkProtectedWrite(join(d, "secrets", "new.txt"), d).blocked).toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("allows normal source files", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-safety-"));
		try {
			expect(checkProtectedWrite(join(d, "src", "index.ts"), d).blocked).toBe(false);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("resolves relative paths against the child cwd", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-safety-"));
		try {
			writeFileSync(join(d, ".env"), "X=1");
			// relative path resolved against cwd=d
			expect(checkProtectedWrite(".env", d).blocked).toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

describe("safetyPreamble", () => {
	it("mentions the key forbidden commands and protected files", () => {
		const p = safetyPreamble();
		expect(p).toMatch(/rm -rf/i);
		expect(p).toMatch(/git push --force/i);
		expect(p).toMatch(/\.env/i);
		expect(p.length).toBeGreaterThan(100);
	});
});
