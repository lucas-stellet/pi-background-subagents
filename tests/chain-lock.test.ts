import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as chainLock from "../chain-lock.ts";

const { tryAcquireChainControllerLock } = chainLock;
const { releaseChainControllerLock } = chainLock as typeof chainLock & {
	releaseChainControllerLock(
		chainDir: string,
		ownerIdentity: { runtimeId: string; pid: number },
	): void;
};

test("rejects a second runtime while the same chain directory has a live controller", (t) => {
	const chainDir = mkdtempSync(join(tmpdir(), "chain-lock-test-"));
	t.after(() => rmSync(chainDir, { recursive: true, force: true }));

	const firstAcquired = tryAcquireChainControllerLock(chainDir, {
		runtimeId: "runtime-1",
		pid: process.pid,
	});
	const secondAcquired = tryAcquireChainControllerLock(chainDir, {
		runtimeId: "runtime-2",
		pid: process.pid,
	});

	assert.equal(firstAcquired, true);
	assert.equal(secondAcquired, false);
});

test("allows a new runtime to acquire after the prior controller process exits", async (t) => {
	const chainDir = mkdtempSync(join(tmpdir(), "chain-lock-test-"));
	t.after(() => rmSync(chainDir, { recursive: true, force: true }));

	const priorOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
		stdio: "ignore",
	});
	t.after(() => {
		if (priorOwner.exitCode === null && priorOwner.signalCode === null) priorOwner.kill();
	});
	assert.ok(priorOwner.pid);

	const firstAcquired = tryAcquireChainControllerLock(chainDir, {
		runtimeId: "runtime-1",
		pid: priorOwner.pid,
	});
	const exited = once(priorOwner, "exit");
	priorOwner.kill();
	await exited;

	const restartedAcquired = tryAcquireChainControllerLock(chainDir, {
		runtimeId: "runtime-2",
		pid: process.pid,
	});

	assert.equal(firstAcquired, true);
	assert.equal(restartedAcquired, true);
});

test("recovers a lock when its dead owner's PID has been reused", async (t) => {
	const chainDir = mkdtempSync(join(tmpdir(), "chain-lock-test-"));
	t.after(() => rmSync(chainDir, { recursive: true, force: true }));

	const priorOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
		stdio: "ignore",
	});
	t.after(() => {
		if (priorOwner.exitCode === null && priorOwner.signalCode === null) priorOwner.kill();
	});
	if (priorOwner.pid === undefined) throw new Error("prior owner process did not start");

	tryAcquireChainControllerLock(chainDir, {
		runtimeId: "runtime-1",
		pid: priorOwner.pid,
	});
	const exited = once(priorOwner, "exit");
	priorOwner.kill();
	await exited;

	const ownerPath = join(chainDir, ".controller-lock", "owner.json");
	const persistedOwner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
	persistedOwner.pid = process.pid;
	writeFileSync(ownerPath, JSON.stringify(persistedOwner));

	const restartedAcquired = tryAcquireChainControllerLock(chainDir, {
		runtimeId: "runtime-2",
		pid: process.pid,
	});

	assert.equal(restartedAcquired, true);
});

test("recovers from a corrupt canonical controller lock", (t) => {
	const chainDir = mkdtempSync(join(tmpdir(), "chain-lock-test-"));
	t.after(() => rmSync(chainDir, { recursive: true, force: true }));

	const lockDir = join(chainDir, ".controller-lock");
	mkdirSync(lockDir);
	writeFileSync(join(lockDir, "owner.json"), '{"runtimeId":"runtime-1"');

	const acquired = tryAcquireChainControllerLock(chainDir, {
		runtimeId: "runtime-2",
		pid: process.pid,
	});

	assert.equal(acquired, true);
});

test("allows a different live runtime to acquire after the owner releases", (t) => {
	const chainDir = mkdtempSync(join(tmpdir(), "chain-lock-test-"));
	t.after(() => rmSync(chainDir, { recursive: true, force: true }));
	const ownerIdentity = {
		runtimeId: "runtime-1",
		pid: process.pid,
	};

	const firstAcquired = tryAcquireChainControllerLock(chainDir, ownerIdentity);
	assert.equal(firstAcquired, true);

	releaseChainControllerLock(chainDir, ownerIdentity);
	const nextAcquired = tryAcquireChainControllerLock(chainDir, {
		runtimeId: "runtime-2",
		pid: process.pid,
	});

	assert.equal(nextAcquired, true);
});
