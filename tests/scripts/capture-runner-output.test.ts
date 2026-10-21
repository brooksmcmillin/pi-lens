/**
 * Unit tests for the capture primitive behind the real-bytes fixtures (#1937).
 *
 * The script writes the provenance header every runner-output fixture is
 * trusted on, so its own helpers need to be right: a version it cannot read
 * must stop the capture, a workspace path must not leak into the repo, and an
 * argument must survive cmd.exe intact.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildAvailability,
	cleanRunRejection,
	expandWorkspaceArgs,
	extractVersion,
	mergeRecords,
	needsShell,
	probeBinaryName,
	quoteForShell,
	recordProblems,
	redactWorkspace,
	resolveBin,
	WORKSPACE_TOKEN,
} from "../../scripts/capture-runner-output.mjs";

describe("extractVersion", () => {
	it("takes the first major.minor token out of a banner", () => {
		expect(extractVersion("actionlint 1.7.12\ninstalled by download")).toBe(
			"1.7.12",
		);
		expect(extractVersion("vale version 3.9.6")).toBe("3.9.6");
		expect(extractVersion("mypy 2.3.1 (compiled: yes)")).toBe("2.3.1");
	});

	// The capture refuses to write a fixture when this returns "". Falling back
	// to "the first line" once recorded a Windows "not compatible with the
	// version of Windows you're running" error AS the tool version.
	// #4522 F10: `mix --version` prints the Erlang runtime's banner first and
	// Mix's second, so the first token in the whole output is erts' version. The
	// record is documented as "the binary that answered", and 15.2.7 is not Mix.
	it("takes the line that leads with the command's own name", () => {
		const banner =
			"Erlang/OTP 27 [erts-15.2.7.4] [source] [64-bit]\n\nMix 1.18.3 (compiled with Erlang/OTP 27)\n";
		expect(extractVersion(banner, "mix")).toBe("1.18.3");
		// Trailing punctuation on the name is part of the banner, not the name.
		expect(extractVersion("fish_indent, version 4.2.1\n", "fish_indent")).toBe(
			"4.2.1",
		);
		// Without a line naming the command, the first token still answers: a
		// banner may name its runtime before itself, and refusing that would
		// reject most tools.
		expect(extractVersion(banner)).toBe("15.2.7");
		expect(
			extractVersion("Ubuntu clang version 21.1.6 (6ubuntu1)", "clang++"),
		).toBe("21.1.6");
	});

	it("takes only the leading block of an answer that is not a banner", () => {
		// biome's `explain` answer: a rule page, not a banner. Its "Available from
		// version" is the rule's, and the binary's own version is nowhere in it.
		const rulePage =
			"Summary\n\n- Name: noUnusedVariables\n- Default severity: warn\n- Available from version: 1.0.0\n";
		expect(extractVersion(rulePage, "biome")).toBe("");
		// The same tool's real banner still answers, blank separator and all.
		expect(extractVersion("Version: 2.5.15\n\n", "biome")).toBe("2.5.15");
		// A banner whose version sits on its second leading line is inside the
		// block, so it is not lost with the rule page.
		expect(
			extractVersion(
				"ShellCheck - shell script analysis tool\nversion: 0.11.0\nlicense: GPLv3\n",
				"shellcheck",
			),
		).toBe("0.11.0");
	});

	it("returns empty for a banner with no version token", () => {
		expect(extractVersion("")).toBe("");
		expect(extractVersion("this program cannot be run")).toBe("");
		expect(
			extractVersion(
				"This version of ktlint.exe is not compatible with the version of Windows you're running.",
			),
		).toBe("");
	});
});

describe("redactWorkspace", () => {
	it("replaces the native, posix, and backslash spellings", () => {
		const workspace = "C:\\Temp\\ws";
		expect(redactWorkspace("at C:\\Temp\\ws\\bad.toml", workspace)).toBe(
			`at ${WORKSPACE_TOKEN}\\bad.toml`,
		);
		expect(redactWorkspace("at C:/Temp/ws/bad.toml", workspace)).toBe(
			`at ${WORKSPACE_TOKEN}/bad.toml`,
		);
	});

	// The JSON-escaped spelling is the one that matters: `--format json` output
	// embeds `C:\\Temp\\ws`, which the raw spelling never matches. Missing it
	// left a local absolute path inside committed fixtures, and the replay then
	// spliced back an invalid JSON escape.
	it("replaces the JSON-escaped spelling", () => {
		const redacted = redactWorkspace(
			'{"file":"C:\\\\Temp\\\\ws\\\\bad.php"}',
			"C:\\Temp\\ws",
		);
		expect(redacted).toBe(`{"file":"${WORKSPACE_TOKEN}\\\\bad.php"}`);
		expect(redacted).not.toContain("Temp");
	});

	it("is a no-op without a workspace", () => {
		expect(redactWorkspace("text", "")).toBe("text");
	});
});

// Recurrence: helm-lint (#4453) hands helm an ABSOLUTE chart root, so a capture
// that spawned `helm lint .` recorded an argv the runner never sends and the
// replay argv tie could not hold. The token lets a manifest entry spawn with the
// workspace's absolute path while the recorded argv stays machine-neutral.
describe("expandWorkspaceArgs", () => {
	it("spawns with the workspace where the manifest wrote the token", () => {
		expect(
			expandWorkspaceArgs(["lint", WORKSPACE_TOKEN], "/tmp/pi-lens-capture-x"),
		).toEqual(["lint", "/tmp/pi-lens-capture-x"]);
	});

	// Recurrence: fish 3.3.1 spells an absolute argv path differently from a
	// relative one, and only a capture spawned with the absolute path holds the
	// bytes production receives (#4454).
	it("expands the token inside an argument, as an absolute file path", () => {
		expect(
			expandWorkspaceArgs([`${WORKSPACE_TOKEN}/bad.fish`], "/tmp/w"),
		).toEqual(["/tmp/w/bad.fish"]);
	});

	it("leaves every other argument alone", () => {
		expect(expandWorkspaceArgs(["--check", "bad.fish"], "/tmp/w")).toEqual([
			"--check",
			"bad.fish",
		]);
	});
});

describe("needsShell", () => {
	it("shells npm shims on Windows but never a real exe", () => {
		expect(needsShell("C:\\tools\\oxlint", "win32")).toBe(true);
		expect(needsShell("C:\\tools\\actionlint.exe", "win32")).toBe(false);
		expect(needsShell("C:\\tools\\ACTIONLINT.EXE", "win32")).toBe(false);
	});

	it("never shells off Windows", () => {
		expect(needsShell("oxlint", "linux")).toBe(false);
		expect(needsShell("oxlint", "darwin")).toBe(false);
	});
});

describe("quoteForShell", () => {
	it("leaves a plain argument alone", () => {
		expect(quoteForShell("--format")).toBe("--format");
		expect(quoteForShell("bad.toml")).toBe("bad.toml");
	});

	it("quotes whitespace and cmd metacharacters", () => {
		expect(quoteForShell("{{json .}}")).toBe('"{{json .}}"');
		expect(quoteForShell("a&b")).toBe('"a&b"');
		expect(quoteForShell("100%")).toBe('"100%"');
	});

	// #1937 round 2: the old version escaped `"` and ignored `\`. Per
	// CommandLineToArgvW a backslash run that abuts the closing quote must be
	// doubled, or the quote is escaped away and the next argument is swallowed.
	it("doubles a trailing backslash run so the closing quote survives", () => {
		expect(quoteForShell("C:\\path with space\\")).toBe(
			'"C:\\path with space\\\\"',
		);
		expect(quoteForShell("C:\\a b\\\\")).toBe('"C:\\a b\\\\\\\\"');
	});

	it("leaves an interior backslash literal", () => {
		expect(quoteForShell("C:\\a b\\c")).toBe('"C:\\a b\\c"');
	});

	it("escapes an embedded quote and the run before it", () => {
		expect(quoteForShell('say "hi"')).toBe('"say \\"hi\\""');
		expect(quoteForShell('a\\"b c')).toBe('"a\\\\\\"b c"');
	});

	it("quotes the empty string so it stays one argument", () => {
		expect(quoteForShell("")).toBe('""');
	});

	/**
	 * Round-trip against the real parser rules. Any argument this produces must
	 * decode back to itself, which is the property the character-by-character
	 * assertions above only sample.
	 */
	function parseWindowsCommandLine(commandLine: string): string[] {
		const args: string[] = [];
		let current = "";
		let inQuotes = false;
		let started = false;
		let backslashes = 0;
		const flushBackslashes = (count: number) => {
			current += "\\".repeat(count);
		};
		for (const character of commandLine) {
			if (character === "\\") {
				backslashes++;
				continue;
			}
			if (character === '"') {
				flushBackslashes(Math.floor(backslashes / 2));
				if (backslashes % 2 === 1) {
					current += '"';
				} else {
					inQuotes = !inQuotes;
					started = true;
				}
				backslashes = 0;
				continue;
			}
			flushBackslashes(backslashes);
			backslashes = 0;
			if (character === " " && !inQuotes) {
				if (started || current.length > 0) args.push(current);
				current = "";
				started = false;
				continue;
			}
			current += character;
		}
		flushBackslashes(backslashes);
		if (started || current.length > 0) args.push(current);
		return args;
	}

	it("round-trips every argument shape through the real parser rules", () => {
		const cases = [
			["--format", "{{json .}}", "bad.yml"],
			["C:\\path with space\\", "next"],
			['say "hi"', "plain"],
			['a\\"b c', "C:\\a b\\c"],
			["", "after-empty"],
			["--filter=bad.tf", "C:\\Users\\dev\\repo\\"],
		];
		for (const argv of cases) {
			const commandLine = argv.map(quoteForShell).join(" ");
			expect(parseWindowsCommandLine(commandLine), commandLine).toEqual(argv);
		}
	});
});

// #4473: the capture records the real tool's answer to the probe its runner
// sends, because the replay runs the real checker against that record. helm 4
// rejects `--version`; a record that dropped the exit status would let the
// replay read a rejected probe as installed.
describe("buildAvailability", () => {
	it("keeps the argv the checker sends and the real exit status", () => {
		expect(
			buildAvailability("helm", ["version", "--short"], {
				status: 1,
				stdout: "",
				stderr: "Error: unknown flag: --short\n",
			}),
		).toEqual({
			command: "helm",
			argv: ["version", "--short"],
			// No version in a rejection: the probe was not answered, so the record
			// says so rather than borrowing the work binary's banner (#4522 F2).
			version: "",
			exitCode: 1,
			stdout: "",
			stderr: "Error: unknown flag: --short\n",
		});
	});

	// #4522 F2: the version is read from THIS probe's own answer. The capture
	// spawned the work binary for every probe, so cpp-check recorded g++'s
	// banner under clang++'s, clang's, gcc's, cc's, c++'s and cl's names.
	it("reads the version out of its own answer, never the caller's", () => {
		expect(
			buildAvailability("cargo", ["--version"], {
				status: 0,
				stdout: "cargo 1.99.0 (5f94df478 2026-08-27)\n",
				stderr: "",
			}).version,
		).toBe("1.99.0");
		expect(
			buildAvailability("biome", ["explain", "noUnusedVariables"], {
				status: 0,
				stdout: "Summary\n\n- Name: noUnusedVariables\n",
				stderr: "",
			}).version,
		).toBe("");
	});

	it("records a spawn with no exit status as null, never as success", () => {
		const record = buildAvailability("helm", ["--version"], {
			status: undefined,
			stdout: "",
			stderr: "spawn helm ENOENT",
		});
		expect(record.exitCode).toBeNull();
	});

	// A probe whose own binary is absent answered nothing. The record says that
	// instead of an empty claim that reads like a rejection.
	it("records a spawn that never happened as an error, not as a version", () => {
		const record = buildAvailability("clang++", ["--version"], {
			status: null,
			stdout: "",
			stderr: "",
			error: new Error("spawnSync clang++ ENOENT"),
		});
		expect(record.exitCode).toBeNull();
		expect(record.version).toBe("");
		expect(record.error).toContain("clang++");
	});

	it("copies the argv so a later edit cannot rewrite the record", () => {
		const argv = ["--version"];
		const record = buildAvailability("yamllint", argv, {
			status: 0,
			stdout: "yamllint 1.38.0",
			stderr: "",
		});
		argv.push("--debug");
		expect(record.argv).toEqual(["--version"]);
	});
});

// #4522 F6: the clean run's exit status decides whether the bytes are a clean
// run at all. Disabling this guard wrote a dirty verdict into a fixture's clean
// half while every test stayed green.
describe("cleanRunRejection", () => {
	it("accepts an exit 0 run", () => {
		expect(
			cleanRunRejection({ status: 0, stdout: "[]", stderr: "" }),
		).toBeNull();
	});

	it("refuses a non-zero exit and names the output", () => {
		const reason = cleanRunRejection({
			status: 1,
			stdout: "found 1 issue in bad.fake\n",
			stderr: "",
		});
		expect(reason).toContain("exited 1");
		expect(reason).toContain("found 1 issue");
	});

	it("refuses a spawn that never ran", () => {
		expect(
			cleanRunRejection({
				status: null,
				stdout: "",
				stderr: "",
				error: new Error("spawnSync x ENOENT"),
			}),
		).toContain("spawn failed");
	});
});

// #4522 F2/F3/F10: one gate decides whether a set of records is evidence about
// THIS fixture. The capture refuses to write past it; the fixture census
// re-runs it over every committed fixture.
describe("recordProblems", () => {
	const fixture = {
		provenance: {
			runner: "elixir-check",
			argv: ["compile", "--warnings-as-errors"],
		},
		availability: [
			{
				command: "mix",
				argv: ["--version"],
				version: "1.18.3",
				exitCode: 0,
				stdout: "Erlang/OTP 27 [erts-15.2.7.4]\n\nMix 1.18.3\n",
				stderr: "",
			},
		],
		clean: {
			workspace: "tests/fixtures/runner-output-clean/elixir-check",
			file: "lib/bad.ex",
			argv: ["compile", "--warnings-as-errors"],
			version: "1.18.3",
			exitCode: 0,
			stdout: "",
			stderr: "",
		},
	};

	it("passes a record about this binary and this invocation", () => {
		expect(recordProblems(fixture)).toEqual([]);
	});

	it("reds a version its own answer never printed", () => {
		const borrowed = {
			...fixture,
			availability: [
				{
					...fixture.availability[0],
					// The Erlang runtime's version under Mix's name: the mislabel F10.
					version: "15.2.7",
				},
			],
		};
		// 15.2.7 IS in the answer (inside erts-15.2.7.4), so a substring tie could
		// not see the mislabel. The tie is exact — the version must be the token
		// `extractVersion` yields from these very bytes — so it does.
		expect(recordProblems(borrowed).join("\n")).toContain("another binary");
		const foreign = {
			...fixture,
			availability: [
				{
					...fixture.availability[0],
					version: "15.2.0-16ubuntu1",
					stdout: "clippy 0.1.99\n",
				},
			],
		};
		expect(recordProblems(foreign).join("\n")).toContain("another binary");
	});

	// #4522 NEW-4: biome's availability checker also sends `explain
	// noUnusedVariables`, and that answer is a rule page whose "Available from
	// version: 1.0.0" is the RULE's version. A record that copied it claimed
	// 1.0.0 for a 2.5.15 binary. The record now carries "" and says so.
	it("reds a rule's version copied out of a non-banner answer", () => {
		const rulePage = {
			...fixture,
			availability: [
				{
					command: "biome",
					argv: ["explain", "noUnusedVariables"],
					version: "1.0.0",
					exitCode: 0,
					stdout:
						"Summary\n\n- Name: noUnusedVariables\n- Fix: unsafe\n- Available from version: 1.0.0\n",
					stderr: "",
				},
			],
		};
		expect(recordProblems(rulePage).join("\n")).toContain("another binary");
		expect(
			recordProblems({
				...rulePage,
				availability: [{ ...rulePage.availability[0], version: "" }],
			}),
		).toEqual([]);
	});

	it("reds a clean run that is not this fixture's invocation", () => {
		const mismatched = {
			...fixture,
			clean: {
				...fixture.clean,
				argv: ["--no-config", "--no-execute", "bad.fish"],
			},
		};
		expect(recordProblems(mismatched).join("\n")).toContain(
			"is not this fixture's own invocation",
		);
	});

	// #4522 NEW review, "Rejected probes cannot be saved": the point of the
	// record is that helm 4 REJECTS `--version` (exit 1, an error on stderr, no
	// version). A gate that demanded a non-empty version could not save it, so
	// the failure stayed unrecorded. "" here says what the answer is: no version
	// banner — and the exit status plus the bytes are the record.
	it("accepts a rejected probe with no version in its answer", () => {
		expect(
			recordProblems({
				...fixture,
				availability: [
					{
						command: "helm",
						argv: ["--version", "--short"],
						version: "",
						exitCode: 1,
						stdout: "",
						stderr: "Error: unknown flag: --version\n",
					},
				],
			}),
		).toEqual([]);
	});

	it("accepts a probe that never ran, and no free-form reason", () => {
		expect(
			recordProblems({
				...fixture,
				availability: [
					{
						command: "clang++",
						argv: ["--version"],
						version: "",
						exitCode: null,
						stdout: "",
						stderr: "",
						error: "clang++ could not be spawned: ENOENT",
					},
				],
			}),
		).toEqual([]);
		expect(
			recordProblems({
				...fixture,
				availability: [
					{ ...fixture.availability[0], version: "", error: undefined },
				],
			}).join("\n"),
		).toContain("no version in its own answer");
	});
});

// #4522 F2: every probe resolves the binary it names, so a checker probing
// `cargo --version` cannot be answered by the work binary wearing that name.
describe("probeBinaryName and resolveBin", () => {
	it("resolves a probe's own command from the bin dir", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-probe-bin-"));
		fs.writeFileSync(path.join(dir, "cargo"), "#!/bin/sh\n", { mode: 0o755 });
		try {
			expect(probeBinaryName("cargo")).toBe("cargo");
			expect(probeBinaryName("/usr/bin/cargo")).toBe("/usr/bin/cargo");
			expect(resolveBin("cargo", dir)).toBe(path.join(dir, "cargo"));
			// An absolute path is the checker's own resolution, not a name to look up.
			expect(resolveBin("/opt/x/cargo", dir)).toBe("/opt/x/cargo");
			// Nothing found: the bare name, so PATH and the child's error decide.
			expect(resolveBin("clang++", dir)).toBe("clang++");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// The retrofit path: fixtures captured before #4473 gain the records without
// re-recording their work bytes from a newer build (which would silently
// retarget the parser evidence).
describe("mergeRecords", () => {
	it("adds the availability and clean records and keeps the work bytes", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-merge-"));
		const dest = path.join(dir, "real.captured.json");
		const original = {
			provenance: {
				runner: "helm-lint",
				tool: "helm",
				version: "4.3.0",
				argv: ["lint", WORKSPACE_TOKEN],
			},
			file: "Chart.yaml",
			exitCode: 0,
			stdout: "captured findings",
			stderr: "",
		};
		fs.writeFileSync(dest, JSON.stringify(original));
		const merged = mergeRecords(dest, {
			availability: [
				{
					command: "helm",
					argv: ["version", "--short"],
					version: "4.3.0",
					exitCode: 0,
					stdout: "v4.3.0",
					stderr: "",
				},
			],
			clean: {
				workspace: "tests/fixtures/runner-output-clean/helm-lint",
				file: "Chart.yaml",
				argv: ["lint", WORKSPACE_TOKEN],
				version: "4.3.0",
				exitCode: 0,
				stdout: "",
				stderr: "",
			},
			versionArgv: ["version", "--short"],
		});

		expect(merged.stdout).toBe("captured findings");
		expect(merged.exitCode).toBe(0);
		expect(merged.availability).toHaveLength(1);
		expect((merged.provenance as Record<string, unknown>).versionArgv).toEqual([
			"version",
			"--short",
		]);
		const onDisk = JSON.parse(fs.readFileSync(dest, "utf8"));
		expect(onDisk.clean.exitCode).toBe(0);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// #4522 F3: the retrofit merged the LAST manifest entry's clean run into
	// every fixture of its runner, so fish-indent's formatter fixture replayed a
	// `fish --no-execute` syntax check as its clean half. The write is refused
	// now, and the fixture is left byte-identical.
	it("refuses a clean run that belongs to another case", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-merge-"));
		const dest = path.join(dir, "real.captured.json");
		fs.writeFileSync(
			dest,
			JSON.stringify({
				provenance: {
					runner: "fish-indent",
					tool: "fish_indent",
					version: "4.9.3",
					argv: ["--check", "unformatted.fish"],
				},
				file: "unformatted.fish",
				exitCode: 1,
				stdout: "",
				stderr: "unformatted.fish\n",
			}),
		);
		const before = fs.readFileSync(dest, "utf8");
		expect(() =>
			mergeRecords(dest, {
				availability: [],
				clean: {
					workspace: "tests/fixtures/runner-output-clean/fish-indent",
					file: "bad.fish",
					argv: ["--no-config", "--no-execute", "bad.fish"],
					version: "4.2.1",
					exitCode: 0,
					stdout: "",
					stderr: "",
				},
			}),
		).toThrow(/not this fixture's own invocation/);
		expect(fs.readFileSync(dest, "utf8")).toBe(before);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
