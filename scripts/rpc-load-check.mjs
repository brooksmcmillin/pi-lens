#!/usr/bin/env node
/**
 * RPC session smoke — drive pi-lens the way an RPC child runs it, headless and
 * model-free, and red on ANY failure signal from start to the end of the first
 * turn.
 *
 * Recurrence this guard names: #4400 (pi exited at session start under
 * `pi --mode rpc` when the snapshot persist worker failed; nobody had run pi as
 * an RPC child with a failing worker) and #4314 (the 4.4.2 tarball failed the
 * LSP warm in every session; this check passed because a failed warm is a log
 * line, not an `extension_error`). Both shipped past a check that only waited
 * for `get_commands`. The issue is #4401.
 *
 * What one run does (about 5 s warm, 12 s with a cold language-server install):
 *   1. spawn `pi --mode rpc` with a PRIVATE agent dir and PI_LENS_HOME, a fake
 *      OpenAI-compatible provider on 127.0.0.1 (no credentials), and pi's own
 *      `defaultProjectTrust: "always"`, so the project is trusted and the LSP
 *      spawn and warm really run;
 *   2. `get_commands`, and assert pi-lens's `lens-*` commands registered;
 *   3. wait for the session-start warm-up (`warmup_total` in latency.log);
 *   4. send a real `prompt` (text-only reply: no tool call runs), wait for
 *      `agent_end` and a clean `stop`;
 *   5. read pi-lens's own logs under the pinned PI_LENS_HOME.
 * It FAILS (exit 1) on any of: the pi process exiting, an `extension_error`
 * event, a pi-lens notice at `warning` or `error` severity
 * (`extension_ui_request` / `notify`), ANY `extension.log` line at `error` or
 * `warn`, a latency.log phase named `*_failed` / `*_error`, a degraded
 * snapshot-worker fallback, or a session that did not log
 * `project trust = trusted`. Exit 2 = a stage timed out. On failure it prints
 * the offending records in full and the log tails (the runner's scratch dies
 * with the job), and retries once when a language-server `auto-install`
 * failed (a registry blip).
 *
 * `--fail-worker` forces the project-snapshot persist worker to answer its
 * first request with `{ id, generation, error }` and no `stagePath` (the #4400
 * wire shape; the seam is PI_LENS_TEST_SNAPSHOT_WORKER_FAIL in
 * clients/project-snapshot-persist-worker.ts, and it forces only that worker,
 * not the review-graph one). Pi must survive, finish the turn
 * and log the main-thread fallback for that exact reason; that one degraded
 * fallback is the only failure signal the variant tolerates.
 *
 * `startRpcSession` is the one RPC driver: scripts/release-qa.mjs and
 * scripts/compat-smoke-behavioral.mjs start pi through it too.
 *
 * Used by .github/workflows/install-smoke.yml (pi-load: the installed package;
 * host-range-smoke: the packed tarball, plus the failing-worker variant).
 *
 * Usage: node scripts/rpc-load-check.mjs [path-to-pi-bin]
 *          [--extension <path-to-pi-lens>] [--fail-worker]
 *   no --extension: pi-lens comes from the ambient agent dir's `packages`
 *   (`pi install`), which this script links into its private agent dir.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { isMainModule } from "./lib/is-main-module.mjs";
import { scratchHomeEnv } from "./lib/scratch-home-env.mjs";
import {
	parseNdjsonEntries,
	phaseWasLogged,
} from "./lib/latency-log-phases.mjs";

/**
 * Where the TypeScript language server stands, from the two logs: started
 * (`lsp_server_spawned` for `typescript` in latency.log), failed (a terminal
 * `lsp spawn typescript: ...` line in sessionstart.log), or undefined while it
 * is still spawning. The smoke project is TypeScript, so a started server is
 * the positive evidence that the LSP leg ran (#4401 review: a refusal that
 * logs after a fixed read never reached the check).
 */
export function tsServerOutcome(latencyRecords, sessionstartText) {
	const spawned = latencyRecords.find(
		(r) =>
			r.phase === "lsp_server_spawned" && r.metadata?.serverId === "typescript",
	);
	if (spawned) return { started: true };
	const line = String(sessionstartText)
		.split("\n")
		.find((l) =>
			/lsp spawn typescript: (unavailable|failed|refused|aborted|permanently disabled)/.test(
				l,
			),
		);
	return line ? { started: false, line: line.trim() } : undefined;
}

/** Every executable `name` on PATH, in order (a runner-image tool can shadow the install). */
function commandsOnPath(name) {
	const found = [];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const file = path.join(dir, name);
		try {
			fs.accessSync(file, fs.constants.X_OK);
			found.push(file);
		} catch {
			// not in this directory
		}
	}
	return found;
}

/** The env var the failing-worker variant sets; the worker echoes it back. */
export const FORCE_WORKER_FAIL_ENV = "PI_LENS_TEST_SNAPSHOT_WORKER_FAIL";
/** The worker's forced error starts with this; the smoke keys its tolerance on it. */
export const FORCED_ERROR_MARKER = "forced snapshot worker failure";
/** Per-stage wait; the env override exists for the spawn test's timeout cases. */
const STAGE_TIMEOUT_MS =
	Number(process.env.RPC_LOAD_CHECK_STAGE_TIMEOUT_MS) || 30000;
/** Notice severities (`notifyType`) that are failures; `info` is not. */
const FAILING_NOTIFY_TYPES = new Set(["warning", "error"]);
/** A latency.log phase named like a failure. */
const FAILING_PHASE = /_(failed|error)$/;

/** An `extension_error` in either shape pi has used. */
export function isExtensionError(message) {
	return (
		message?.type === "extension_error" ||
		(message?.type === "event" && message.event === "extension_error")
	);
}

/**
 * Failure carried by one RPC stdout message, or undefined. Shapes (pi docs
 * json.md / rpc-extension-ui.md): `{type:"extension_error",...}` (older hosts
 * wrap it as `{type:"event",event:"extension_error"}`), and a notice is
 * `{type:"extension_ui_request",method:"notify",message,notifyType}` with
 * `notifyType` defaulting to `info`.
 */
export function rpcMessageFailure(message) {
	if (!message || typeof message !== "object") return undefined;
	if (isExtensionError(message)) {
		return `extension_error: ${String(message.error ?? "").slice(0, 300)} (${String(message.event ?? "")})`;
	}
	if (message.type === "extension_ui_request" && message.method === "notify") {
		const severity = message.notifyType ?? "info";
		if (FAILING_NOTIFY_TYPES.has(severity)) {
			return `${severity} notice: ${String(message.message ?? "").slice(0, 300)}`;
		}
	}
	return undefined;
}

/**
 * Failure carried by one record of pi-lens's own logs, or undefined.
 * `file` is `extension.log` (NDJSON, `level`) or `latency.log` (NDJSON,
 * `type:"phase"`). `allowFallbackReason` is the one degraded worker fallback
 * the failing-worker variant expects.
 */
export function logRecordFailure(file, record, allowFallbackReason) {
	if (!record || typeof record !== "object") return undefined;
	if (file === "extension.log") {
		if (record.level !== "error" && record.level !== "warn") return undefined;
		return `extension.log ${record.level} [${record.subsystem}]: ${String(record.message ?? "").slice(0, 300)}`;
	}
	if (file === "latency.log" && record.type === "phase") {
		const phase = String(record.phase ?? "");
		if (phase === "project_snapshot_worker_fallback") {
			if (record.metadata?.degraded !== true) return undefined;
			const reason = String(record.metadata?.reason ?? "");
			if (allowFallbackReason && reason.includes(allowFallbackReason)) {
				return undefined;
			}
			return `latency.log degraded snapshot worker fallback: ${reason.slice(0, 300)}`;
		}
		if (FAILING_PHASE.test(phase)) {
			return `latency.log phase ${phase}: ${JSON.stringify(record.metadata ?? {}).slice(0, 300)}`;
		}
	}
	return undefined;
}

function readNdjson(file) {
	try {
		return parseNdjsonEntries(fs.readFileSync(file, "utf8"));
	} catch {
		return [];
	}
}

/** A minimal OpenAI-compatible streaming completion: one `ok` reply, no tools. */
function startFakeProvider() {
	const state = { requests: 0 };
	const server = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			state.requests++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta, finish) =>
				`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
			res.write(chunk({ role: "assistant", content: "ok" }));
			res.write(chunk({}, "stop"));
			res.write(
				`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
			);
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () =>
			resolve({ server, state, port: server.address().port }),
		);
	});
}

/** Private agent dir: the fake provider, plus the ambient packages when no --extension. */
function writeAgentDir(agentDir, port, linkAmbientPackages) {
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "fake",
					models: [{ id: "fake-model" }],
				},
			},
		}),
	);
	// pi's own setting: an RPC child has no UI to answer the trust prompt, and an
	// untrusted project refuses the LSP spawn (the leg this smoke exists to run).
	const settings = {
		defaultProvider: "fake",
		defaultModel: "fake-model",
		defaultProjectTrust: "always",
	};
	if (linkAmbientPackages) {
		const ambient =
			process.env.PI_CODING_AGENT_DIR ||
			path.join(os.homedir(), ".pi", "agent");
		try {
			const ambientSettings = JSON.parse(
				fs.readFileSync(path.join(ambient, "settings.json"), "utf8"),
			);
			for (const key of ["packages", "npmCommand"]) {
				if (ambientSettings[key] !== undefined)
					settings[key] = ambientSettings[key];
			}
		} catch {
			// no ambient settings: the command assertion below reports "did it load?"
		}
		for (const dir of ["npm", "git"]) {
			try {
				fs.symlinkSync(
					path.join(ambient, dir),
					path.join(agentDir, dir),
					"dir",
				);
			} catch {
				// no such ambient dir
			}
		}
	}
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify(settings),
	);
}

class StageTimeout extends Error {}

/**
 * Spawn `pi` and frame its stdout as JSONL. The one RPC driver: this script's
 * session smoke, release-qa's `get_commands` probe and the compat smoke's
 * runs all start pi here, so the framing, the `extension_error` reading and
 * the exit handling exist once (#4401; the two copies it replaced stopped at
 * the first `get_commands` answer).
 *
 * `failures` holds every failure signal read off the wire (see
 * `rpcMessageFailure`); `extensionErrors` only the `extension_error` events.
 */
export function startRpcSession(
	piBin,
	{ args, cwd, env, shell = false, stderr = "pipe" },
) {
	const child = spawn(piBin, args, {
		cwd,
		env,
		shell,
		stdio: ["pipe", "pipe", stderr],
	});
	const session = {
		child,
		failures: [],
		extensionErrors: [],
		stderrTail: [],
		exited: undefined,
		commandsResponse: undefined,
		agentEnd: undefined,
		/** Called with each parsed stdout message. */
		onMessage: (fn) => messageListeners.push(fn),
		/** Called once with the exit code. */
		onExit: (fn) => exitListeners.push(fn),
		send(message) {
			try {
				child.stdin.write(`${JSON.stringify(message)}\n`);
			} catch {
				// an exited pi is reported through `exited`
			}
		},
		kill() {
			try {
				child.kill("SIGKILL");
			} catch {}
		},
	};
	const messageListeners = [];
	const exitListeners = [];
	let buf = "";
	child.stderr?.on("data", (d) => {
		session.stderrTail.push(d.toString());
		if (session.stderrTail.length > 200) session.stderrTail.shift();
	});
	child.stdin.on("error", () => {
		// a write to an exited pi; `exited` reports it
	});
	child.on("exit", (code, signal) => {
		session.exited = { code, signal };
		for (const fn of exitListeners) fn(code, signal);
	});
	child.stdout.on("data", (d) => {
		// Strict JSONL: split on LF only (per pi RPC framing rules).
		buf += d.toString();
		let i = buf.indexOf("\n");
		while (i >= 0) {
			const line = buf.slice(0, i).replace(/\r$/, "");
			buf = buf.slice(i + 1);
			i = buf.indexOf("\n");
			if (!line.trim()) continue;
			let m;
			try {
				m = JSON.parse(line);
			} catch {
				continue;
			}
			const failure = rpcMessageFailure(m);
			if (failure) session.failures.push(failure);
			if (isExtensionError(m)) session.extensionErrors.push(m);
			if (m.type === "response" && m.command === "get_commands")
				session.commandsResponse = m;
			if (m.type === "agent_end") session.agentEnd = m;
			for (const fn of messageListeners) fn(m);
		}
	});
	return session;
}

const tailOf = (text, lines) => text.split("\n").filter(Boolean).slice(-lines);

/**
 * One session smoke. Resolves `{ code, installFailed }` and prints its verdict;
 * code 0 pass, 1 failure signals, 2 a stage timed out.
 */
export async function run(piBin, { extension, failWorker }) {
	const scratch = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-rpc-session-smoke-"),
	);
	const agentDir = path.join(scratch, "agent");
	const lensHome = path.join(scratch, "lens-home");
	fs.mkdirSync(lensHome, { recursive: true });
	const provider = await startFakeProvider();
	writeAgentDir(agentDir, provider.port, !extension);

	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		...scratchHomeEnv(path.join(scratch, "home"), lensHome),
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
	};
	// pi-lens writes no logs under a test runner; this smoke needs them.
	delete env.VITEST;
	if (env.NODE_ENV === "test") delete env.NODE_ENV;
	if (failWorker) env[FORCE_WORKER_FAIL_ENV] = "no-stage-path";
	else delete env[FORCE_WORKER_FAIL_ENV];

	const args = ["--mode", "rpc", "--no-session"];
	if (extension) args.push("-e", path.resolve(extension));
	// Printed on every run: a PATH tsc changes which TypeScript compiler pi-lens finds.
	console.log(`tsc on PATH: ${commandsOnPath("tsc").join(", ") || "none"}`);
	const pi = startRpcSession(piBin, { args, env });
	const failures = pi.failures;
	const offending = [];

	const stage = { name: "start" };
	const waitFor = async (what, ms, probe) => {
		stage.name = what;
		const deadline = Date.now() + ms;
		for (;;) {
			if (pi.exited) return undefined;
			const value = probe();
			if (value) return value;
			if (Date.now() > deadline)
				throw new StageTimeout(`TIMEOUT waiting for ${what} (${ms}ms)`);
			await new Promise((r) => setTimeout(r, 50));
		}
	};
	const latency = () => readNdjson(path.join(lensHome, "latency.log"));
	const readLog = (name) => {
		try {
			return fs.readFileSync(path.join(lensHome, name), "utf8");
		} catch {
			return "";
		}
	};
	const forcedFallback = () =>
		latency().find(
			(r) =>
				r.phase === "project_snapshot_worker_fallback" &&
				String(r.metadata?.reason ?? "").includes(FORCED_ERROR_MARKER),
		);

	let timedOut;
	try {
		// Give pi a moment to open stdin before the first command.
		await new Promise((r) => setTimeout(r, 500));
		pi.send({ id: "cmds", type: "get_commands" });
		await waitFor(
			"get_commands response",
			STAGE_TIMEOUT_MS,
			() => pi.commandsResponse,
		);
		if (!pi.exited) {
			const cmds = pi.commandsResponse?.data?.commands || [];
			const lens = cmds.filter(
				(c) =>
					String(c.name || "").startsWith("lens-") ||
					String(c.path || "").includes("pi-lens"),
			);
			console.log(
				`total commands: ${cmds.length}; pi-lens commands: ${lens.map((c) => c.name).join(", ") || "(none)"}`,
			);
			if (!lens.length)
				failures.push("pi-lens registered no commands (did it load?)");
		}
		await waitFor(
			"session-start warm-up (warmup_total in latency.log)",
			STAGE_TIMEOUT_MS,
			() => phaseWasLogged(latency(), "warmup_total"),
		);
		pi.send({ id: "turn", type: "prompt", message: "hello" });
		await waitFor(
			"first turn (agent_end)",
			STAGE_TIMEOUT_MS,
			() => pi.agentEnd,
		);
		if (pi.agentEnd && !pi.exited) {
			const last = [...(pi.agentEnd.messages || [])]
				.reverse()
				.find((m) => m.role === "assistant");
			if (!last || last.stopReason !== "stop")
				failures.push(
					`first turn did not finish cleanly: stopReason=${last?.stopReason ?? "(no assistant message)"}`,
				);
			if (provider.state.requests < 1)
				failures.push("first turn never reached the fake provider");
		}
		// The LSP spawn is asynchronous: its refusal logs about a second after
		// the turn ends (the PATH-compiler probe), so wait for a terminal state.
		const tsServer = await waitFor(
			"the TypeScript language server to start or fail (lsp_server_spawned in latency.log)",
			STAGE_TIMEOUT_MS,
			() => tsServerOutcome(latency(), readLog("sessionstart.log")),
		);
		if (tsServer && !tsServer.started)
			failures.push(
				`the TypeScript language server did not start: ${tsServer.line}`,
			);
		if (failWorker) {
			await waitFor(
				"the forced worker failure's main-thread fallback",
				STAGE_TIMEOUT_MS / 2,
				() => forcedFallback(),
			);
		} else {
			// Post-turn work (the snapshot save after the turn) must settle too.
			await new Promise((r) => setTimeout(r, 1000));
		}
	} catch (err) {
		if (err instanceof StageTimeout) timedOut = err.message;
		else throw err;
	}

	if (pi.exited) {
		failures.push(
			`pi exited during "${stage.name}" (code ${pi.exited.code}, signal ${pi.exited.signal})`,
		);
	}
	// The LSP spawn and the warm only run in a trusted project; an untrusted
	// one would leave that leg dark and green.
	const trustLine = tailOf(readLog("sessionstart.log"), 1e9).find((l) =>
		l.includes("project trust = "),
	);
	if (!trustLine?.includes("project trust = trusted")) {
		failures.push(
			`smoke project is not trusted: the LSP spawn and warm are not exercised (${trustLine?.trim() ?? "no 'project trust' line in sessionstart.log"})`,
		);
	}
	for (const r of readNdjson(path.join(lensHome, "extension.log"))) {
		const f = logRecordFailure("extension.log", r);
		if (f) {
			failures.push(f);
			offending.push(["extension.log", r]);
		}
	}
	for (const r of latency()) {
		const f = logRecordFailure(
			"latency.log",
			r,
			failWorker ? FORCED_ERROR_MARKER : undefined,
		);
		if (f) {
			failures.push(f);
			offending.push(["latency.log", r]);
		}
	}

	// Graceful stop (stdin EOF runs pi's own teardown, which ends any language
	// server), then SIGKILL if it does not leave in 5 s.
	try {
		pi.child.stdin.end();
	} catch {}
	for (let waited = 0; !pi.exited && waited < 5000; waited += 50)
		await new Promise((r) => setTimeout(r, 50));
	pi.kill();
	provider.server.close();
	const unique = [...new Set(failures)];
	// A registry blip fails the language-server install, and the failure then
	// shows up as a cascade (a deno launch failure); name it and let main retry.
	const installFailures = readLog("sessionstart.log")
		.split("\n")
		.filter((l) =>
			/auto-install[^\n]*(fail|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)/i.test(l),
		);
	if (unique.length || timedOut) {
		for (const f of unique) console.log(`FAIL: ${f}`);
		if (timedOut) console.log(timedOut);
		// The runner's scratch dies with the job: print what a reader needs.
		for (const [file, record] of offending)
			console.log(`offending record (${file}): ${JSON.stringify(record)}`);
		for (const l of installFailures) console.log(`install failure: ${l}`);
		for (const name of ["sessionstart.log", "extension.log"]) {
			console.log(`--- ${name} (last 40 lines)`);
			console.log(tailOf(readLog(name), 40).join("\n"));
		}
		if (pi.stderrTail.length)
			console.log(`pi stderr (tail):\n${pi.stderrTail.join("").slice(-2000)}`);
		console.log(`scratch kept for forensics: ${scratch}`);
		return {
			code: unique.length ? 1 : 2,
			installFailed: installFailures.length > 0,
		};
	}
	fs.rmSync(scratch, { recursive: true, force: true });
	console.log(
		`PASS: pi-lens loaded and survived start, warm-up and the first turn${failWorker ? " with the snapshot worker forced to fail" : ""}`,
	);
	return { code: 0, installFailed: false };
}

async function main(argv) {
	const opts = { extension: undefined, failWorker: false };
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--extension") opts.extension = argv[++i];
		else if (argv[i] === "--fail-worker") opts.failWorker = true;
		else positional.push(argv[i]);
	}
	const piBin = positional[0] || "pi";
	let result = await run(piBin, opts);
	if (result.code === 1 && result.installFailed) {
		console.log("auto-install failed in the run above: retrying once");
		result = await run(piBin, opts);
	}
	return result.code;
}

if (isMainModule(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			console.log(`ERROR: ${err?.stack || err}`);
			process.exit(1);
		},
	);
}
