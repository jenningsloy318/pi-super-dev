import { redCheckOptions } from "../src/stages/implementation.ts";
export function redCheckOptionsDefaultBranch(defaultBranch?: string): string | undefined {
	// the exact call shape implementation.ts:1297 uses
	const opts = redCheckOptions({ signal: undefined, log: () => {}, events: { emit() {} }, budget: { check: () => true } } as never, "phase-01", undefined, defaultBranch);
	return (opts as { defaultBranch?: string }).defaultBranch;
}
