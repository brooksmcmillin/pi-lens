import { describe, expect, it } from "vitest";
import { getLanguageId } from "../../../clients/lsp/language.js";

describe("lsp language mapping", () => {
	it("resolves extension-based language ids", () => {
		expect(getLanguageId("src/main.ts")).toBe("typescript");
		expect(getLanguageId("src/script.sh")).toBe("shellscript");
		expect(getLanguageId("src/config.fish")).toBe("fish");
		expect(getLanguageId("cmake/helpers.cmake")).toBe("cmake");
		expect(getLanguageId("src/Main.lean")).toBe("lean");
	});

	it("resolves basename-only language ids", () => {
		expect(getLanguageId("Dockerfile")).toBe("dockerfile");
		expect(getLanguageId("infra/Dockerfile")).toBe("dockerfile");
		expect(getLanguageId("CMakeLists.txt")).toBe("cmake");
		expect(getLanguageId("src/CMakeLists.txt")).toBe("cmake");
	});

	it("returns undefined when no mapping exists", () => {
		expect(getLanguageId("README")).toBeUndefined();
	});

	// #4636: these files are `.json` by extension and JSONC by convention, and
	// the JSON server reads `languageId === 'jsonc'` as "comments are allowed"
	// (`vscode-langservers-extracted` 4.10.0,
	// `lib/json-language-server/jsonServer.js:521`). The closed catalog is
	// microsoft/vscode 1.105.0 `extensions/typescript-basics/package.json`
	// (the tsconfig/jsconfig family) and `extensions/json/package.json` (the
	// jsonc basenames), quoted on the `jsonc` registry entry.
	it("announces the JSONC-by-convention config files as jsonc", () => {
		expect(getLanguageId("tsconfig.json")).toBe("jsonc");
		expect(getLanguageId("packages/web/tsconfig.app.json")).toBe("jsonc");
		expect(getLanguageId("tsconfig-build.json")).toBe("jsonc");
		expect(getLanguageId("jsconfig.json")).toBe("jsonc");
		expect(getLanguageId("jsconfig.base.json")).toBe("jsonc");
		expect(getLanguageId("babel.config.json")).toBe("jsonc");
		expect(getLanguageId("typedoc.json")).toBe("jsonc");
		expect(getLanguageId(".babelrc.json")).toBe("jsonc");
		expect(getLanguageId(".eslintrc.json")).toBe("jsonc");
	});

	it("keeps every other .json file on the extension's answer", () => {
		expect(getLanguageId("data.json")).toBe("json");
		expect(getLanguageId("tsconfig.json5")).toBe("json");
		expect(getLanguageId("mytconfig.json")).toBe("json");
		expect(getLanguageId("tsconfigx.json")).toBe("json");
		// The declared `*` segment is non-empty: `tsconfig..json` has an empty one.
		expect(getLanguageId("tsconfig..json")).toBe("json");
		expect(getLanguageId("tsconfig/sub.json")).toBe("json");
	});
});
