import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
	DEFAULT_ARTIFACT_USAGE_WARNING_BYTES,
	DEFAULT_STDOUT_SEGMENT_BYTES,
	DEFAULT_STDOUT_SEGMENT_COUNT,
	createArtifactUsageWarningCoordinator,
	createRollingEventWriter,
	createRecoveringQueue,
	ensurePrivateDirectory,
	isDiskPressureError,
	measureArtifactUsage,
	resolveArtifactRoots,
	withDiskPressureContainment,
} from "../job-storage.ts";

function tempRoot(t: test.TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "job-storage-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function records(paths: string[]): Array<{ n: number }> {
	return paths.flatMap((path) =>
		readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
	);
}

test("filters message_update and malformed stdout while retaining other valid events", async (t) => {
	const writer = createRollingEventWriter(tempRoot(t));

	await writer.appendLine(JSON.stringify({ type: "message_update", n: 1 }));
	await writer.appendLine("not json");
	await writer.appendLine(JSON.stringify({ type: "message_end", n: 2 }));

	assert.deepEqual(records(writer.segmentPaths()), [{ type: "message_end", n: 2 }]);
});

test("keeps five bounded segments, evicts oldest first, and recovers after an oversized record", async (t) => {
	assert.equal(DEFAULT_STDOUT_SEGMENT_COUNT, 5);
	assert.equal(DEFAULT_STDOUT_SEGMENT_BYTES, 2 * 1024 * 1024);
	const line = JSON.stringify({ n: 0, text: "x".repeat(20) });
	const segmentBytes = Buffer.byteLength(line) + 1;
	const writer = createRollingEventWriter(tempRoot(t), { segmentBytes, segmentCount: 5 });

	for (let n = 0; n < 8; n++) await writer.appendLine(JSON.stringify({ n, text: "x".repeat(20) }));
	await writer.appendLine(JSON.stringify({ n: 99, text: "x".repeat(segmentBytes) }));
	await writer.appendLine(JSON.stringify({ n: 8, text: "x".repeat(20) }));

	const paths = writer.segmentPaths();
	assert.ok(paths.length <= 5);
	assert.ok(paths.every((path) => readFileSync(path).byteLength <= segmentBytes));
	assert.equal(basename(paths.at(-1)!), "stdout.jsonl");
	assert.deepEqual(records(paths).map(({ n }) => n), [4, 5, 6, 7, 8]);
});

test("resolves the fixed persistent roots and creates private artifact directories and files", async (t) => {
	const home = tempRoot(t);
	const outside = join(home, "outside");
	mkdirSync(outside, { mode: 0o755 });
	const roots = resolveArtifactRoots({ home });
	assert.deepEqual(roots, {
		baseDir: join(home, ".local", "state", "pi-background-subagents"),
		subagentsDir: join(home, ".local", "state", "pi-background-subagents", "subagents"),
		chainsDir: join(home, ".local", "state", "pi-background-subagents", "chains"),
	});
	mkdirSync(roots.baseDir, { recursive: true, mode: 0o755 });
	await ensurePrivateDirectory(roots.baseDir);
	await ensurePrivateDirectory(roots.subagentsDir);
	const jobDir = join(roots.subagentsDir, "session", "job");
	const writer = createRollingEventWriter(jobDir);
	await writer.appendLine(JSON.stringify({ type: "message_end" }));

	if (process.platform !== "win32") {
		assert.equal(statSync(roots.baseDir).mode & 0o777, 0o700);
		assert.equal(statSync(roots.subagentsDir).mode & 0o777, 0o700);
		assert.equal(statSync(jobDir).mode & 0o777, 0o700);
		assert.equal(statSync(join(jobDir, "stdout.jsonl")).mode & 0o777, 0o600);
		assert.equal(statSync(outside).mode & 0o777, 0o755);
	}
});

test("measures both artifact roots without following symlinks and never removes artifacts", async (t) => {
	const home = tempRoot(t);
	const roots = resolveArtifactRoots({ home });
	const subagentFile = join(roots.subagentsDir, "session", "job", "stdout.jsonl");
	const chainFile = join(roots.chainsDir, "session", "chain", "outputs", "result.md");
	const outside = join(home, "outside");
	mkdirSync(join(roots.subagentsDir, "session", "job"), { recursive: true });
	mkdirSync(join(roots.subagentsDir, "session", "linked-dir"), { recursive: true });
	mkdirSync(join(roots.chainsDir, "session", "chain", "outputs"), { recursive: true });
	mkdirSync(outside);
	writeFileSync(subagentFile, "abc");
	writeFileSync(chainFile, "12345");
	writeFileSync(join(outside, "secret"), "not counted");
	symlinkSync(join(outside, "secret"), join(roots.subagentsDir, "session", "linked-file"));
	symlinkSync(outside, join(roots.subagentsDir, "session", "linked-dir", "outside"));

	assert.equal(await measureArtifactUsage(roots), 8);
	assert.equal(await measureArtifactUsage({ ...roots, chainsDir: join(home, "missing") }), 3);
	assert.equal(await measureArtifactUsage({ ...roots, subagentsDir: join(home, "missing-subagents"), chainsDir: join(home, "missing-chains") }), 0);
	assert.equal(existsSync(subagentFile), true);
	assert.equal(existsSync(chainFile), true);
});

test("warns only above the strict 50 GiB threshold and retains artifacts", async (t) => {
	assert.equal(DEFAULT_ARTIFACT_USAGE_WARNING_BYTES, 50 * 1024 ** 3);
	const root = tempRoot(t);
	const retained = join(root, "retained");
	writeFileSync(retained, "keep");
	const warnings: string[] = [];
	for (const usage of [DEFAULT_ARTIFACT_USAGE_WARNING_BYTES - 1, DEFAULT_ARTIFACT_USAGE_WARNING_BYTES, DEFAULT_ARTIFACT_USAGE_WARNING_BYTES + 1]) {
		const coordinator = createArtifactUsageWarningCoordinator({
			measure: async () => usage,
			notify: (message) => warnings.push(message),
			manualCleanupPath: "/home/test/.local/state/pi-background-subagents",
		});
		await coordinator.check();
	}
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /50(?:\.0+)? GiB/);
	assert.match(warnings[0], /\/home\/test\/\.local\/state\/pi-background-subagents/);
	assert.equal(existsSync(retained), true);
});

test("coalesces scans, throttles scans and warnings, and contains notification and scan failures", async () => {
	let now = 0;
	let calls = 0;
	let release!: (usage: number) => void;
	const pending = new Promise<number>((resolve) => { release = resolve; });
	const warnings: string[] = [];
	const coordinator = createArtifactUsageWarningCoordinator({
		now: () => now,
		measure: async () => { calls++; return pending; },
		notify: () => { throw new Error("UI unavailable"); },
		warn: (message) => warnings.push(message),
		scanIntervalMs: 100,
		warningCooldownMs: 1_000,
	});
	const first = coordinator.check();
	const second = coordinator.check();
	assert.equal(calls, 1);
	release(DEFAULT_ARTIFACT_USAGE_WARNING_BYTES + 1);
	await Promise.all([first, second]);
	assert.equal(warnings.length, 1);

	now = 10;
	await coordinator.check();
	assert.equal(calls, 1, "scan interval suppresses a second scan");
	now = 100;
	await coordinator.check();
	assert.equal(calls, 2);
	assert.equal(warnings.length, 1, "warning cooldown suppresses spam");
	now = 1_000;
	await coordinator.check();
	assert.equal(calls, 3);
	assert.equal(warnings.length, 2);

	await assert.doesNotReject(createArtifactUsageWarningCoordinator({
		measure: async () => { throw new Error("unreadable"); },
		notify: () => warnings.push("unexpected"),
	}).check());
});

test("contains quota and space errors without poisoning later queued writes, but surfaces other errors", async () => {
	for (const error of [
		Object.assign(new Error("quota"), { code: "EDQUOT" }),
		Object.assign(new Error("full"), { code: "ENOSPC" }),
		Object.assign(new Error("quota"), { errno: -122 }),
		Object.assign(new Error("quota"), { errno: 122 }),
		new Error("Unknown system error -122"),
	]) assert.equal(isDiskPressureError(error), true);
	const unrelated = Object.assign(new Error("permission denied"), { code: "EACCES" });
	assert.equal(isDiskPressureError(unrelated), false);
	await withDiskPressureContainment(async () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); });
	await assert.rejects(() => withDiskPressureContainment(async () => { throw unrelated; }), unrelated);

	const queue = createRecoveringQueue();
	await queue.run(async () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); });
	let laterAttempted = false;
	await queue.run(async () => { laterAttempted = true; });
	assert.equal(laterAttempted, true);
});
