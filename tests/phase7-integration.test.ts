import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");

function readJson(relativePath: string): unknown {
	const content = readFileSync(join(ROOT, relativePath), "utf8");
	return JSON.parse(content);
}

// ---------------------------------------------------------------------------
// Validation Step 2: All schema files are valid JSON with correct structure
// ---------------------------------------------------------------------------
describe("Schema files validation", () => {
	const schemasDir = join(ROOT, "workflows/super-dev/schemas");
	const schemaFiles = readdirSync(schemasDir).filter((f) =>
		f.endsWith(".schema.json"),
	);

	it("has at least one schema file", () => {
		expect(schemaFiles.length).toBeGreaterThan(0);
	});

	// Unsupported keywords in pi-workflow schema format
	const unsupportedKeywords = [
		"$ref",
		"$defs",
		"pattern",
		"oneOf",
		"anyOf",
		"allOf",
		"if",
		"then",
		"else",
		"not",
		"patternProperties",
		"dependencies",
		"dependentSchemas",
		"dependentRequired",
	];

	for (const file of schemaFiles) {
		describe(`schemas/${file}`, () => {
			let schema: Record<string, unknown>;

			it("is valid JSON", () => {
				const content = readFileSync(join(schemasDir, file), "utf8");
				schema = JSON.parse(content) as Record<string, unknown>;
				expect(schema).toBeDefined();
			});

			it('has "type": "object"', () => {
				const content = readFileSync(join(schemasDir, file), "utf8");
				schema = JSON.parse(content) as Record<string, unknown>;
				expect(schema.type).toBe("object");
			});

			it('has "required" array', () => {
				const content = readFileSync(join(schemasDir, file), "utf8");
				schema = JSON.parse(content) as Record<string, unknown>;
				expect(Array.isArray(schema.required)).toBe(true);
			});

			it('has "properties" object', () => {
				const content = readFileSync(join(schemasDir, file), "utf8");
				schema = JSON.parse(content) as Record<string, unknown>;
				expect(typeof schema.properties).toBe("object");
				expect(schema.properties).not.toBeNull();
			});

			it("uses only supported schema keywords", () => {
				const content = readFileSync(join(schemasDir, file), "utf8");
				for (const keyword of unsupportedKeywords) {
					expect(content).not.toContain(`"${keyword}"`);
				}
			});
		});
	}
});

// ---------------------------------------------------------------------------
// Validation Step 3: spec.json is valid
// ---------------------------------------------------------------------------
describe("spec.json validation", () => {
	const specPath = "workflows/super-dev/spec.json";

	it("exists", () => {
		expect(existsSync(join(ROOT, specPath))).toBe(true);
	});

	it('has "name": "super-dev"', () => {
		const spec = readJson(specPath) as Record<string, unknown>;
		expect(spec.name).toBe("super-dev");
	});

	it("has artifactGraph.stages array", () => {
		const spec = readJson(specPath) as Record<string, unknown>;
		const graph = spec.artifactGraph as Record<string, unknown>;
		expect(graph).toBeDefined();
		expect(Array.isArray(graph.stages)).toBe(true);
	});

	it("each stage has required fields (id, type)", () => {
		const spec = readJson(specPath) as Record<string, unknown>;
		const graph = spec.artifactGraph as Record<string, unknown>;
		const stages = graph.stages as Array<Record<string, unknown>>;
		for (const stage of stages) {
			expect(stage.id).toBeDefined();
			expect(typeof stage.id).toBe("string");
			expect(stage.type).toBeDefined();
			expect(["single", "dynamic", "parallel", "gate"]).toContain(stage.type);
		}
	});

	it("dynamic stage references controller correctly", () => {
		const spec = readJson(specPath) as Record<string, unknown>;
		const graph = spec.artifactGraph as Record<string, unknown>;
		const stages = graph.stages as Array<Record<string, unknown>>;
		const dynamicStages = stages.filter((s) => s.type === "dynamic");
		for (const stage of dynamicStages) {
			const dyn = stage.dynamic as Record<string, unknown>;
			expect(dyn).toBeDefined();
			expect(dyn.uses).toBeDefined();
			// Controller file must exist
			const controllerPath = join(
				ROOT,
				"workflows/super-dev",
				dyn.uses as string,
			);
			expect(existsSync(controllerPath)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Validation Step 4: All helpers export default function
// ---------------------------------------------------------------------------
describe("Helper files validation", () => {
	const helpersDir = join(ROOT, "workflows/super-dev/helpers");
	const helperFiles = readdirSync(helpersDir).filter((f) =>
		f.endsWith(".mjs"),
	);

	it("has at least one helper file", () => {
		expect(helperFiles.length).toBeGreaterThan(0);
	});

	for (const file of helperFiles) {
		describe(`helpers/${file}`, () => {
			it("passes node --check (valid JavaScript syntax)", () => {
				const filePath = join(helpersDir, file);
				expect(() => {
					execSync(`node --check "${filePath}"`, { encoding: "utf8" });
				}).not.toThrow();
			});

			it("exports a default function", () => {
				const content = readFileSync(join(helpersDir, file), "utf8");
				expect(content).toMatch(
					/export\s+default\s+(async\s+)?function/,
				);
			});
		});
	}
});

// ---------------------------------------------------------------------------
// Validation Step 5: All agents have valid frontmatter
// ---------------------------------------------------------------------------
describe("Agent files validation", () => {
	const agentsDir = join(ROOT, "agents");
	const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));

	it("has at least one agent file", () => {
		expect(agentFiles.length).toBeGreaterThan(0);
	});

	for (const file of agentFiles) {
		describe(`agents/${file}`, () => {
			it("has YAML frontmatter delimiters", () => {
				const content = readFileSync(join(agentsDir, file), "utf8");
				const lines = content.split("\n");
				expect(lines[0]).toBe("---");
				const closingIdx = lines.indexOf("---", 1);
				expect(closingIdx).toBeGreaterThan(1);
			});

			it("has name field in frontmatter", () => {
				const content = readFileSync(join(agentsDir, file), "utf8");
				const lines = content.split("\n");
				const closingIdx = lines.indexOf("---", 1);
				const frontmatter = lines.slice(1, closingIdx).join("\n");
				expect(frontmatter).toMatch(/^name:\s*.+/m);
			});

			it("has tools field in frontmatter", () => {
				const content = readFileSync(join(agentsDir, file), "utf8");
				const lines = content.split("\n");
				const closingIdx = lines.indexOf("---", 1);
				const frontmatter = lines.slice(1, closingIdx).join("\n");
				expect(frontmatter).toMatch(/^tools:\s*.+/m);
			});
		});
	}
});

// ---------------------------------------------------------------------------
// Validation Step 6: Skill file has frontmatter
// ---------------------------------------------------------------------------
describe("Skill SKILL.md validation", () => {
	const skillPath = join(ROOT, "skills/super-dev/SKILL.md");

	it("exists", () => {
		expect(existsSync(skillPath)).toBe(true);
	});

	it("has YAML frontmatter", () => {
		const content = readFileSync(skillPath, "utf8");
		const lines = content.split("\n");
		expect(lines[0]).toBe("---");
		const closingIdx = lines.indexOf("---", 1);
		expect(closingIdx).toBeGreaterThan(1);
	});

	it("has name field", () => {
		const content = readFileSync(skillPath, "utf8");
		const lines = content.split("\n");
		const closingIdx = lines.indexOf("---", 1);
		const frontmatter = lines.slice(1, closingIdx).join("\n");
		expect(frontmatter).toMatch(/^name:\s*.+/m);
	});

	it("has description field", () => {
		const content = readFileSync(skillPath, "utf8");
		const lines = content.split("\n");
		const closingIdx = lines.indexOf("---", 1);
		const frontmatter = lines.slice(1, closingIdx).join("\n");
		expect(frontmatter).toMatch(/^description:\s*.+/m);
	});
});
