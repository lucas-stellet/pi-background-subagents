import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerBackgroundSubagentTool } from "../index.ts";

function createHarness(t: test.TestContext) {
	const projectDir = mkdtempSync(join(tmpdir(), "subagent-spawn-project-"));
	const storageHome = mkdtempSync(join(tmpdir(), "subagent-spawn-home-"));
	const sessionId = `subagent-spawn-${process.pid}-${Date.now()}-${Math.random()}`;
	mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "agents", "test-agent.md"), "---\nname: test-agent\ndescription: Test agent\n---\n");
	t.after(() => {
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(storageHome, { recursive: true, force: true });
	});

	const tools = new Map<string, any>();
	const pi = {
		registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
		registerCommand() {},
		on() {},
		appendEntry() {},
		async sendUserMessage() {},
	} as unknown as ExtensionAPI;
	registerBackgroundSubagentTool(pi, { storageHome });
	const ctx = {
		cwd: projectDir,
		hasUI: false,
		mode: "rpc",
		isProjectTrusted: () => false,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => undefined,
		},
	} as unknown as ExtensionContext;
	const execute = (cwd: string) => tools.get("subagent").execute(
		"subagent-spawn-call",
		{ action: "start", agent: "test-agent", agentScope: "project", task: "test", cwd },
		new AbortController().signal,
		undefined,
		ctx,
	);
	return { execute, projectDir, storageHome, sessionId };
}

function resultText(result: any): string {
	return result.content.map((item: { text?: string }) => item.text ?? "").join("\n");
}

function useTrueExecutable(t: test.TestContext) {
	const originalExecPath = process.execPath;
	Object.defineProperty(process, "execPath", { value: "/bin/true", configurable: true });
	t.after(() => Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true }));
}

function captureUncaught(t: test.TestContext): Error[] {
	const errors: Error[] = [];
	process.setUncaughtExceptionCaptureCallback((error) => errors.push(error instanceof Error ? error : new Error(String(error))));
	t.after(() => process.setUncaughtExceptionCaptureCallback(null));
	return errors;
}

test("public subagent start resolves supported cwd forms and rejects named-user tilde", async (t) => {
	const { execute, projectDir } = createHarness(t);
	captureUncaught(t);
	useTrueExecutable(t);
	const relativeDir = join(projectDir, "relative");
	mkdirSync(relativeDir);
	const absoluteDir = mkdtempSync(join(tmpdir(), "subagent-spawn-absolute-"));
	t.after(() => rmSync(absoluteDir, { recursive: true, force: true }));

	const results = await Promise.all([execute("~"), execute("~/.."), execute("relative"), execute(absoluteDir), execute("~other-user/work")]);
	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.equal(results[0].details.job.cwd, homedir());
	assert.equal(results[1].details.job.cwd, resolve(homedir(), ".."));
	assert.equal(results[2].details.job.cwd, relativeDir);
	assert.equal(results[3].details.job.cwd, absoluteDir);
	assert.equal(results[4].isError, true);
	assert.match(resultText(results[4]), /named-user|unsupported|use ~|absolute/i);
	assert.ok(isAbsolute(results[2].details.job.cwd));
});

test("public subagent start rejects missing and non-directory resolved cwd values", async (t) => {
	const { execute, projectDir } = createHarness(t);
	captureUncaught(t);
	useTrueExecutable(t);
	const missing = "missing-directory";
	const missingResolved = join(projectDir, missing);
	const file = join(projectDir, "not-a-directory");
	writeFileSync(file, "not a directory");

	const missingResult = await execute(missing);
	const fileResult = await execute(file);
	await new Promise((resolve) => setTimeout(resolve, 50));

	for (const [result, received, resolved] of [[missingResult, missing, missingResolved], [fileResult, file, file]] as const) {
		assert.equal(result.isError, true, resultText(result));
		assert.match(resultText(result), new RegExp(received.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(resultText(result), new RegExp(resolved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(resultText(result), /directory|correct|exist/i);
		assert.equal(result.details.receivedCwd, received);
		assert.equal(result.details.resolvedCwd, resolved);
	}
});

test("public subagent start contains an immediate spawn failure and persists a failed job", async (t) => {
	const { execute, storageHome, sessionId } = createHarness(t);
	const uncaught = captureUncaught(t);
	const originalExecPath = process.execPath;
	const unavailableExecutable = join(tmpdir(), `missing-pi-${process.pid}-${Date.now()}`);
	assert.equal(existsSync(unavailableExecutable), false);
	Object.defineProperty(process, "execPath", { value: unavailableExecutable, configurable: true });
	t.after(() => Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true }));
	const result = await execute(process.cwd());
	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.equal(uncaught.length, 0, uncaught.map((error) => error.message).join("\n"));
	assert.equal(result.isError, true, resultText(result));
	assert.match(resultText(result), /launch|start|check|unable/i);
	assert.equal(result.details.job.status, "failed");
	assert.ok(result.details.job.errorMessage);
	assert.ok(result.details.job.finishedAt);
	assert.equal(result.details.job.pid, undefined);
	const persisted = JSON.parse(readFileSync(join(storageHome, ".local", "state", "pi-background-subagents", "subagents", sessionId, result.details.job.id, "status.json"), "utf8"));
	assert.equal(persisted.status, "failed");
	assert.ok(persisted.errorMessage);
	assert.ok(persisted.finishedAt);
	assert.equal(persisted.pid, undefined);
});
