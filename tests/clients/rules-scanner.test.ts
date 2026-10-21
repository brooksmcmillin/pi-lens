import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanProjectRules } from "../../clients/rules-scanner.js";
import { removeTempDirSync } from "./test-utils.js";

describe("rules-scanner depth cap (#250/#747 class)", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rules-"));
	});

	afterEach(() => {
		removeTempDirSync(tmp);
	});

	it("stops recursing past the depth cap while keeping shallow rules", () => {
		const rulesDir = path.join(tmp, ".claude", "rules");
		fs.mkdirSync(rulesDir, { recursive: true });
		fs.writeFileSync(path.join(rulesDir, "shallow.md"), "# shallow\n");

		// 9 nested directories → the file inside sits one level below the depth-8
		// cap and must be excluded; a symlink loop or pathological tree can't run
		// this away.
		let deep = rulesDir;
		for (let i = 1; i <= 9; i++) {
			deep = path.join(deep, `d${i}`);
		}
		fs.mkdirSync(deep, { recursive: true });
		fs.writeFileSync(path.join(deep, "deep.md"), "# deep\n");

		const result = scanProjectRules(tmp);
		const names = result.rules.map((r) => r.name);

		expect(names).toContain("shallow.md");
		expect(names).not.toContain("deep.md");
	});
});
