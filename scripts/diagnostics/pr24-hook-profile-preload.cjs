// D9 only: observe builtin boundaries without rewriting the instrumented guard.
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const started = process.hrtime.bigint();
const initialCpu = process.cpuUsage();
const stats = {
	reads: 0,
	bytes: 0,
	eagain: 0,
	otherReadErrors: 0,
	readCallNs: 0,
	parkCalls: 0,
	parkNs: 0,
	wrapperBookkeepingNs: 0,
	checkpointWriteNs: 0,
	recordWriteErrors: 0,
};
let firstRead;
let firstReadCpu;
const elapsed = (since) => Number(process.hrtime.bigint() - since);
const save = (phase) => {
	const checkpointStart = process.hrtime.bigint();
	try {
		fs.writeFileSync(
			process.env.PI_LENS_HOOK_PROFILE_IO,
			JSON.stringify({
				phase,
				...stats,
				preloadToNowNs: elapsed(started),
				cpuMicros: process.cpuUsage(initialCpu),
				resourceUsage: process.resourceUsage(),
				activeMutantAbsent: globalThis.__stryker__?.activeMutant === undefined,
				coveredMutantCount: Object.keys(
					globalThis.__stryker__?.mutantCoverage?.static ?? {},
				).length,
			}),
		);
	} catch {
		// Never turn an observer I/O failure into the hook's allow/crash arm.
		stats.recordWriteErrors++;
	} finally {
		stats.checkpointWriteNs += elapsed(checkpointStart);
	}
};
const read = fs.readSync;
fs.readSync = function (...args) {
	if (args[0] !== 0) return Reflect.apply(read, this, args);
	const wrapperStart = process.hrtime.bigint();
	if (firstRead === undefined) {
		firstRead = wrapperStart;
		firstReadCpu = process.cpuUsage();
	}
	stats.reads++;
	const callStart = process.hrtime.bigint();
	let eof = false;
	let callNs;
	try {
		const bytes = Reflect.apply(read, this, args);
		callNs = elapsed(callStart);
		stats.bytes += bytes;
		eof = bytes === 0;
		return bytes;
	} catch (error) {
		callNs = elapsed(callStart);
		if (error.code === "EAGAIN") stats.eagain++;
		else stats.otherReadErrors++;
		throw error;
	} finally {
		stats.readCallNs += callNs;
		if (eof) {
			stats.stdinWallNs = elapsed(firstRead);
			stats.stdinCpuMicros = process.cpuUsage(firstReadCpu);
		}
		stats.wrapperBookkeepingNs += elapsed(wrapperStart) - callNs;
		// One early checkpoint survives a later classifier timeout; never log input.
		if (eof) save("stdin-eof");
	}
};
const wait = Atomics.wait;
Atomics.wait = function (...args) {
	const wrapperStart = process.hrtime.bigint();
	stats.parkCalls++;
	const callStart = process.hrtime.bigint();
	try {
		return Reflect.apply(wait, this, args);
	} finally {
		const callNs = elapsed(callStart);
		stats.parkNs += callNs;
		stats.wrapperBookkeepingNs += elapsed(wrapperStart) - callNs;
	}
};
syncBuiltinESMExports();
process.on("exit", () => save("exit"));
