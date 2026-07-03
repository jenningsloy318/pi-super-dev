import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

function readJson(relativePath: string): unknown {
	const content = readFileSync(join(ROOT, relativePath), "utf8");
	return JSON.parse(content);
}

function fileExists(relativePath: string): boolean {
	return existsSync(join(ROOT, relativePath));
}

function isDirectory(relativePath: string): boolean {
	const fullPath = join(ROOT, relativePath);
	return existsSync(fullPath) && statSync(fullPath).isDirectory();
}

// ---------------------------------------------------------------------------
// Task 1.1: package.json
// ---------------------------------------------------------------------------
describe("Task 1.1: package.json", () => {
	it("exists", () => {
		expect(fileExists("package.json")).toBe(true);
	});

	it("has correct package name", () => {
		const pkg = readJson("package.json") as Record<string, unknown>;
		expect(pkg.name).toBe("@jenningsloy318/pi-super-dev");
	});

	it("has type module", () => {
		const pkg = readJson("package.json") as Record<string, unknown>;
		expect(pkg.type).toBe("module");
	});

	it("has pi.extensions entry pointing to ./src/extension.ts", () => {
		const pkg = readJson("package.json") as Record<string, unknown>;
		const pi = pkg.pi as Record<string, unknown>;
		expect(pi).toBeDefined();
		expect(pi.extensions).toContain("./src/extension.ts");
	});

	it("has pi.skills entry pointing to ./skills/super-dev", () => {
		const pkg = readJson("package.json") as Record<string, unknown>;
		const pi = pkg.pi as Record<string, unknown>;
		expect(pi).toBeDefined();
		expect(pi.skills).toContain("./skills/super-dev");
	});

	it("has required keywords: pi-package, pi-extension, workflow, pi", () => {
		const pkg = readJson("package.json") as Record<string, unknown>;
		const keywords = pkg.keywords as string[];
		expect(keywords).toContain("pi-package");
		expect(keywords).toContain("pi-extension");
		expect(keywords).toContain("workflow");
		expect(keywords).toContain("pi");
	});

	it("has no runtime dependencies (self-contained)", () => {
		const pkg = readJson("package.json") as Record<string, unknown>;
		expect(pkg.dependencies).toBeUndefined();
		expect(pkg.peerDependencies).toBeUndefined();
	});

	it("has no runtime dependencies (self-contained)", () => {
		const pkg = readJson("package.json") as Record<string, unknown>;
		expect(pkg.dependencies).toBeUndefined();
		expect(pkg.peerDependencies).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Task 1.2: tsconfig.json
// ---------------------------------------------------------------------------
describe("Task 1.2: tsconfig.json", () => {
	it("exists", () => {
		expect(fileExists("tsconfig.json")).toBe(true);
	});

	it("targets ES2022", () => {
		const tsconfig = readJson("tsconfig.json") as Record<string, unknown>;
		const opts = tsconfig.compilerOptions as Record<string, unknown>;
		expect(opts.target).toBe("ES2022");
	});

	it("uses NodeNext module", () => {
		const tsconfig = readJson("tsconfig.json") as Record<string, unknown>;
		const opts = tsconfig.compilerOptions as Record<string, unknown>;
		expect(opts.module).toBe("NodeNext");
	});

	it("uses NodeNext moduleResolution", () => {
		const tsconfig = readJson("tsconfig.json") as Record<string, unknown>;
		const opts = tsconfig.compilerOptions as Record<string, unknown>;
		expect(opts.moduleResolution).toBe("NodeNext");
	});

	it("has strict mode enabled", () => {
		const tsconfig = readJson("tsconfig.json") as Record<string, unknown>;
		const opts = tsconfig.compilerOptions as Record<string, unknown>;
		expect(opts.strict).toBe(true);
	});

	it("has noEmit set to true", () => {
		const tsconfig = readJson("tsconfig.json") as Record<string, unknown>;
		const opts = tsconfig.compilerOptions as Record<string, unknown>;
		expect(opts.noEmit).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Task 1.3: src/extension.ts
// ---------------------------------------------------------------------------
describe("Task 1.3: src/extension.ts", () => {
	it("exists", () => {
		expect(fileExists("src/extension.ts")).toBe(true);
	});

	it("exports a default function", () => {
		const content = readFileSync(join(ROOT, "src/extension.ts"), "utf8");
		// Should have "export default function" pattern
		expect(content).toMatch(/export\s+default\s+function/);
	});

	it("accepts ExtensionAPI parameter", () => {
		const content = readFileSync(join(ROOT, "src/extension.ts"), "utf8");
		expect(content).toContain("ExtensionAPI");
	});
});

// ---------------------------------------------------------------------------
// Task 1.4: Directory structure and README
// ---------------------------------------------------------------------------
describe("Task 1.4: Directory structure", () => {
	it("has agents/ directory", () => {
		expect(isDirectory("agents")).toBe(true);
	});

	it("has workflows/super-dev/ directory", () => {
		expect(isDirectory("workflows/super-dev")).toBe(true);
	});

	it("has workflows/super-dev/schemas/ directory", () => {
		expect(isDirectory("workflows/super-dev/schemas")).toBe(true);
	});

	it("has workflows/super-dev/helpers/ directory", () => {
		expect(isDirectory("workflows/super-dev/helpers")).toBe(true);
	});

	it("has skills/super-dev/ directory", () => {
		expect(isDirectory("skills/super-dev")).toBe(true);
	});

	it("has docs/ directory", () => {
		expect(isDirectory("docs")).toBe(true);
	});
});

describe("Task 1.4: README.md", () => {
	it("exists", () => {
		expect(fileExists("README.md")).toBe(true);
	});

	it("contains project name", () => {
		const content = readFileSync(join(ROOT, "README.md"), "utf8");
		expect(content).toContain("pi-super-dev");
	});

	it("contains description section", () => {
		const content = readFileSync(join(ROOT, "README.md"), "utf8");
		// Should have some descriptive content beyond just the title
		expect(content.length).toBeGreaterThan(100);
	});

	it("contains installation section", () => {
		const content = readFileSync(join(ROOT, "README.md"), "utf8");
		expect(content.toLowerCase()).toMatch(/install/);
	});

	it("contains usage section", () => {
		const content = readFileSync(join(ROOT, "README.md"), "utf8");
		expect(content.toLowerCase()).toMatch(/usage/);
	});
});

describe("Task 1.4: LICENSE", () => {
	it("exists", () => {
		expect(fileExists("LICENSE")).toBe(true);
	});

	it("is MIT license", () => {
		const content = readFileSync(join(ROOT, "LICENSE"), "utf8");
		expect(content).toContain("MIT");
	});
});
