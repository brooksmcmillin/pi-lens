import { describe, expect, it } from "vitest";
import { filterInactivePiLensSkills } from "../../clients/conditional-skills.js";

const prompt = `prefix
<available_skills>
  <skill><name>pi-lens-write-ast-grep-rule</name><location>/skills/write/SKILL.md</location></skill>
  <skill><name>pi-lens-ast-grep</name><location>/skills/ast/SKILL.md</location></skill>
  <skill><name>pi-lens-lsp-navigation</name><location>/skills/lsp/SKILL.md</location></skill>
</available_skills>
<skill name="pi-lens-ast-grep">explicit invocation body</skill>`;

describe("conditional pi-lens skill catalog", () => {
	it("hides both lazy navigation guides while their tools are inactive", () => {
		const filtered = filterInactivePiLensSkills(prompt, { selectedTools: ["read", "lens_diagnostics"] });
		expect(filtered).toContain("pi-lens-write-ast-grep-rule");
		expect(filtered).not.toContain("<name>pi-lens-ast-grep</name>");
		expect(filtered).not.toContain("<name>pi-lens-lsp-navigation</name>");
		expect(filtered).toContain('<skill name="pi-lens-ast-grep">explicit invocation body</skill>');
	});

	it("reveals only the AST guide for an active AST tool", () => {
		const filtered = filterInactivePiLensSkills(prompt, { selectedTools: ["ast_grep_dump"] });
		expect(filtered).toContain("<name>pi-lens-ast-grep</name>");
		expect(filtered).not.toContain("<name>pi-lens-lsp-navigation</name>");
	});

	it("reveals only the LSP guide for active navigation", () => {
		const filtered = filterInactivePiLensSkills(prompt, { selectedTools: ["lsp_navigation"] });
		expect(filtered).not.toContain("<name>pi-lens-ast-grep</name>");
		expect(filtered).toContain("<name>pi-lens-lsp-navigation</name>");
	});

	it("preserves both guides on an older host without selected-tool metadata", () => {
		expect(filterInactivePiLensSkills(prompt, {})).toBe(prompt);
	});

	it("preserves both guides when all lazy families are active", () => {
		expect(filterInactivePiLensSkills(prompt, { selectedTools: ["ast_grep_search", "lsp_navigation"] })).toBe(prompt);
	});
});
