/**
 * Integration tests for the safety factory (Gap 4.3) — retire the "the hook is
 * only verified by SDK contract" caveat as far as is possible without a live
 * model. Two layers:
 *  1. The real createSafetyExtensionFactory registers a tool_call handler on an
 *     ExtensionAPI and that handler blocks/allows correctly (factory dispatch).
 *  2. The real SDK DefaultResourceLoader({noExtensions, extensionFactories})
 *     actually loads our factory without error (loader wiring).
 * The only residual link not unit-testable without a live model is the SDK's
 * runtime routing of tool_call events to extension handlers — documented
 * behavior verified from source (C5/C6/C9 in pi-sdk-architecture-verification.md).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createSafetyExtensionFactory } from "../src/safety.ts";

// Minimal fake ExtensionAPI that captures `on(event, handler)` registrations.
function capturingPi(): { pi: any; handler: (event: any, ctx: any) => Promise<any> | undefined } {
	const handlers: Record<string, (event: any, ctx: any) => Promise<any> | undefined> = {};
	const pi = { on: (event: string, handler: any) => { handlers[event] = handler; } };
	createSafetyExtensionFactory()(pi as any);
	return { pi, handler: handlers["tool_call"] };
}

describe("safety factory: registration + dispatch", () => {
	it("registers a tool_call handler", () => {
		const { handler } = capturingPi();
		expect(typeof handler).toBe("function");
	});

	it("blocks a dangerous bash command", async () => {
		const { handler } = capturingPi();
		const r = await handler({ toolName: "bash", input: { command: "rm -rf /" } }, { cwd: "/tmp" });
		expect(r?.block).toBe(true);
		expect(String(r?.reason)).toMatch(/rm -rf/);
	});

	it("blocks a force-push", async () => {
		const { handler } = capturingPi();
		const r = await handler({ toolName: "bash", input: { command: "git push --force origin main" } }, { cwd: "/tmp" });
		expect(r?.block).toBe(true);
	});

	it("allows a safe bash command (returns undefined)", async () => {
		const { handler } = capturingPi();
		const r = await handler({ toolName: "bash", input: { command: "npm install" } }, { cwd: "/tmp" });
		expect(r).toBeUndefined();
	});

	it("blocks overwriting an existing .env via the write tool", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-safetyint-"));
		try {
			const env = join(d, ".env");
			writeFileSync(env, "SECRET=1");
			const { handler } = capturingPi();
			const r = await handler({ toolName: "write", input: { path: env } }, { cwd: d });
			expect(r?.block).toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("allows creating a new source file via the write tool", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-safetyint-"));
		try {
			const { handler } = capturingPi();
			const r = await handler({ toolName: "write", input: { path: join(d, "src", "x.ts") } }, { cwd: d });
			expect(r).toBeUndefined();
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("handles a write with no path gracefully", async () => {
		const { handler } = capturingPi();
		const r = await handler({ toolName: "write", input: {} }, { cwd: "/tmp" });
		expect(r).toBeUndefined();
	});
});

describe("safety factory: real SDK loader wiring", () => {
	it("DefaultResourceLoader({noExtensions, extensionFactories}) loads the factory without error", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-safetyint-"));
		try {
			const loader = new DefaultResourceLoader({
				cwd: d,
				agentDir: d,
				settingsManager: SettingsManager.inMemory(),
				noExtensions: true,
				extensionFactories: [createSafetyExtensionFactory()],
			});
			await loader.reload();
			const result = loader.getExtensions();
			expect(result.errors).toEqual([]);
			expect(result.extensions.length).toBeGreaterThanOrEqual(1);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});
