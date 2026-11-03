// #4929: fallow-lsp, the opt-in language-scoped auxiliary LSP server, through
// the real per-edit route: `pilens_analyze` runs `dispatchLintWithResult`, whose
// lsp runner reads the flag per call and touches the file with the enabled
// auxiliary ids. The binary is NOT on PATH: with the gate on, pi-lens downloads
// the pinned release into the run's pi-lens home (network required), checks its
// sha256 and launches it. Nothing here is a mock.
//   off     no config: no fallow diagnostic, nothing downloaded, no process
//   config  ~/.pi-lens/config.json fallow.enabled=true: the unused export is
//           reported by fallow, and a Python file never attaches it
//   flag    the same through the tool's `flags` override (the CLI-flag tier)
//   bad     fallow.enabled="yes" (malformed): behaves as `off`
import fs from "node:fs";
import path from "node:path";

export const variants = ["off", "config", "flag", "bad"];

const SOURCE = "src/util.ts";
const PY = "src/script.py";
const FALLOW = /unusedExport|fallow:unused-export|unused-export/;
// The workspace path carries the scenario name, so a finding is matched by the
// tool and rule names the diagnostics render, never by a bare "fallow".
const FALLOW_TOOL = /"tool":\s*"fallow"|fallow:[a-z-]+/;

export async function setup(ctx, variant) {
	ctx.write(
		"package.json",
		'{ "name": "fx", "version": "1.0.0", "main": "src/index.ts", "type": "module" }\n',
	);
	ctx.write(
		"tsconfig.json",
		'{ "compilerOptions": { "target": "es2022", "module": "esnext", "strict": true } }\n',
	);
	ctx.write(
		"src/index.ts",
		'import { used } from "./util.js";\nconsole.log(used());\n',
	);
	ctx.write(
		SOURCE,
		"export function used(): number {\n\treturn 1;\n}\nexport function unusedExport(): number {\n\treturn 2;\n}\n",
	);
	ctx.write(PY, "def f():\n    return 1\n");
	// A repository root: the auxiliaries root at the nearest .git.
	fs.mkdirSync(path.join(ctx.ws, ".git"), { recursive: true });
	const configDir = path.join(process.env.HOME, ".pi-lens");
	fs.mkdirSync(configDir, { recursive: true });
	const configFile = path.join(configDir, "config.json");
	fs.rmSync(configFile, { force: true });
	if (variant === "config")
		fs.writeFileSync(configFile, '{ "fallow": { "enabled": true } }\n');
	if (variant === "bad")
		fs.writeFileSync(configFile, '{ "fallow": { "enabled": "yes" } }\n');
}

/** Live descendants of this run whose command line names fallow-lsp. */
function fallowProcesses() {
	const known = JSON.parse(
		fs.readFileSync(path.join(process.env.RUN, "pids.json"), "utf8"),
	);
	return known.filter((k) => {
		try {
			// argv[0] only: the MCP server's own command line names this scenario's
			// workspace, which contains "fallow-lsp".
			const argv0 = fs
				.readFileSync(`/proc/${k.pid}/cmdline`, "utf8")
				.split("\0")[0];
			return path.basename(argv0).replace(/\.exe$/, "") === "fallow-lsp";
		} catch {
			return false;
		}
	});
}

export async function run(ctx, variant) {
	const piHome = process.env.PI_LENS_HOME;
	const installed = () =>
		fs.existsSync(path.join(piHome, "tools", "fallow-lsp", "fallow-lsp"));
	const on = variant === "config" || variant === "flag";
	const args = {
		file: SOURCE,
		...(variant === "flag" ? { flags: { "lens-fallow": true } } : {}),
	};

	let last;
	// A cold first touch pays the download and the spawn; later touches are warm.
	for (let attempt = 1; attempt <= (on ? 8 : 2); attempt++) {
		last = await ctx.call(
			"pilens_analyze",
			args,
			`analyze ${SOURCE} #${attempt}`,
		);
		if (on && FALLOW.test(last.text)) break;
		await ctx.sleep(on ? 4000 : 500);
	}

	if (on) {
		ctx.expect(
			"fallow reports the unused export through the production touch path",
			FALLOW.test(last.text),
			last.text
				.split("\n")
				.filter((l) => FALLOW.test(l))
				.join(" | "),
		);
		ctx.expect(
			"the pinned release was downloaded and extracted by pi-lens itself",
			installed(),
		);
		ctx.expect("a fallow-lsp process is running", fallowProcesses().length > 0);
		ctx.expect(
			"fallow findings are advisory: no blocker in the result",
			!/BLOCKING|🔴 STOP/.test(last.text),
		);
		const py = await ctx.call(
			"pilens_analyze",
			{ ...args, file: PY },
			`analyze ${PY}`,
		);
		ctx.expect(
			"a non-TS file gets no fallow diagnostic",
			!FALLOW_TOOL.test(py.text),
		);
	} else {
		ctx.expect("no fallow diagnostic", !FALLOW_TOOL.test(last.text));
		ctx.expect("nothing was downloaded", !installed());
		ctx.expect(
			"no fallow-lsp process was started",
			fallowProcesses().length === 0,
		);
		ctx.expect(
			"no fallow-lsp directory exists in the pi-lens home",
			!fs.existsSync(path.join(piHome, "tools", "fallow-lsp")),
		);
	}
	fs.writeFileSync(path.join(ctx.evidenceDir, "analyze-last.txt"), last.text);
	// The turn-end summary of the file just analysed: with the gate off its text
	// is what master prints, so a run on an old tree diffs against this one.
	await ctx.sleep(4000);
	const turnEnd = await ctx.call(
		"pilens_turn_end",
		{ files: [path.join(ctx.ws, SOURCE)] },
		"turn end",
	);
	fs.writeFileSync(path.join(ctx.evidenceDir, "turn-end.txt"), turnEnd.text);
	if (!on)
		ctx.expect(
			"the turn-end summary names no fallow finding",
			!FALLOW_TOOL.test(turnEnd.text),
		);
}
