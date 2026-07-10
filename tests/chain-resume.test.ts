import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as chainLock from "../chain-lock.ts";
import * as chainResume from "../chain-resume.ts";
import type { ChainScope } from "../chains.ts";
import { registerBackgroundSubagentTool } from "../index.ts";

test("resume repairs a stale running phase for another attempt without changing completed output", () => {
	const completedPhase = {
		stageId: "context",
		phaseId: "context",
		agent: "context-builder",
		status: "complete" as const,
		attempts: [{
			attempt: 1,
			status: "complete" as const,
			startedAt: "2026-07-10T10:00:00.000Z",
			finishedAt: "2026-07-10T10:01:00.000Z",
		}],
		outputs: ["context.md"],
	};
	const chainRun = {
		id: "chain-1",
		sessionId: "session-1",
		chain: "tdd-pipeline",
		chainSource: "user" as const,
		task: "Fix stale resume",
		cwd: "/tmp/project",
		chainDir: "/tmp/chain-1",
		status: "running" as const,
		startedAt: "2026-07-10T10:00:00.000Z",
		chainFilePath: "/tmp/tdd-pipeline.chain.yaml",
		stages: [
			{ id: "context", mode: "sequential" as const, phaseIds: ["context"] },
			{ id: "red", mode: "sequential" as const, phaseIds: ["red"] },
		],
		phases: [completedPhase, {
			stageId: "red",
			phaseId: "red",
			agent: "red",
			status: "running" as const,
			attempts: [{
				attempt: 1,
				status: "running" as const,
				startedAt: "2026-07-10T10:01:00.000Z",
				jobId: "dead-job",
			}],
			outputs: [],
		}],
	};
	const interruptedAt = "2026-07-10T10:05:00.000Z";

	const repaired = chainResume.repairInterruptedChainForResume(chainRun, {
		controllerAlive: false,
		phaseProcessAlive: false,
		interruptedAt,
	});

	assert.equal(repaired.phases[1].status, "failed");
	assert.equal(repaired.phases[1].attempts.at(-1)?.status, "failed");
	assert.equal(repaired.phases[1].attempts.at(-1)?.finishedAt, interruptedAt);
	assert.equal(repaired.phases[1].attempts.length, 1);
	assert.deepEqual(repaired.phases[0], completedPhase);
});

test("preparing a failed chain to resume clears terminal metadata without resetting its frontier", () => {
	const chainRun = {
		status: "failed" as const,
		errorMessage: "red phase failed",
		failedStageId: "red",
		failedPhaseId: "red",
		finishedAt: "2026-07-10T10:02:00.000Z",
		phases: [{
			status: "complete" as const,
			attempts: [{ attempt: 1, status: "complete" as const }],
			outputs: ["context.md"],
		}, {
			status: "failed" as const,
			attempts: [{ attempt: 1, status: "failed" as const }],
			outputs: [],
		}],
	};
	const frontier = structuredClone(chainRun.phases);

	const prepared = chainResume.prepareChainRunForResume(chainRun);

	assert.equal(prepared.status, "running");
	assert.equal(prepared.errorMessage, undefined);
	assert.equal(prepared.failedStageId, undefined);
	assert.equal(prepared.failedPhaseId, undefined);
	assert.equal(prepared.finishedAt, undefined);
	assert.deepEqual(prepared.phases, frontier);
});

test("resume without an explicit scope reuses the project scope persisted at start", () => {
	const persistedRun = JSON.parse(JSON.stringify({ chainScope: "project" as const })) as { chainScope: ChainScope };

	const resumeScope = chainResume.resolveChainScopeForResume(persistedRun);

	assert.equal(resumeScope, "project");
});

test("resume rejects a failed chain while its parallel-stage controller is still alive", () => {
	const persistedRun = {
		id: "chain-1",
		status: "failed",
		phases: [
			{ phaseId: "failed-sibling", status: "failed" },
			{ phaseId: "running-sibling", status: "running" },
		],
	};

	const eligibility = chainResume.checkChainResumeEligibility(persistedRun, {
		controllerAlive: true,
		phaseProcessAlive: true,
	});

	assert.equal(persistedRun.phases[1].status, "running");
	assert.deepEqual(eligibility, {
		eligible: false,
		code: "still_running",
		message: "Chain chain-1 is still running and cannot be resumed.",
	});
});

test("resume rejects a completed chain without restarting it", () => {
	const persistedRun = { id: "chain-1", status: "complete" };
	let continuationCalls = 0;

	const eligibility = chainResume.checkChainResumeEligibility(persistedRun);
	if (eligibility.eligible) {
		persistedRun.status = "running";
		continuationCalls += 1;
	}

	assert.deepEqual(eligibility, {
		eligible: false,
		code: "already_complete",
		message: "Chain chain-1 is already complete and cannot be resumed.",
	});
	assert.equal(persistedRun.status, "complete");
	assert.equal(continuationCalls, 0);
});

test("resume rejects a chain whose persisted definition identity no longer matches", () => {
	const startedDefinition = {
		name: "tdd-pipeline",
		description: "TDD pipeline",
		source: "project" as const,
		filePath: "/tmp/tdd-pipeline.chain.yaml",
		stages: [{
			id: "red",
			mode: "sequential" as const,
			reads: [],
			phases: [{
				id: "red",
				agent: "red",
				model: "provider/model",
				reads: [],
				outputs: ["red.md"],
				prompt: "Write a failing test",
			}],
		}],
	};
	const discoveredDefinition = structuredClone(startedDefinition);
	discoveredDefinition.stages[0].phases[0].id = "red-tests";
	const persistedRun: { status: string; chainDefinitionFingerprint?: string } = {
		status: "failed",
		chainDefinitionFingerprint: chainResume.computeChainDefinitionFingerprint(startedDefinition),
	};
	let continuationCalls = 0;

	const compatibility = chainResume.checkChainDefinitionCompatibility(
		persistedRun.chainDefinitionFingerprint,
		discoveredDefinition,
	);
	if (compatibility.compatible) {
		persistedRun.status = "running";
		continuationCalls += 1;
	}

	assert.deepEqual(compatibility, { compatible: false, code: "definition_changed" });
	assert.equal(persistedRun.status, "failed");
	assert.equal(continuationCalls, 0);
});

test("public chain resume honors a persistent controller lock held by another runtime", async (t) => {
	const projectDir = mkdtempSync(join(tmpdir(), "chain-resume-project-"));
	const sessionId = `chain-resume-session-${process.pid}-${Date.now()}`;
	const chainId = "locked-chain";
	const chainDir = join(tmpdir(), "pi-chains", sessionId, chainId);
	const chainFile = join(projectDir, ".pi", "chains", "locked.chain.yaml");
	const lockOwner = { runtimeId: "external-runtime", pid: process.pid };
	t.after(() => {
		chainLock.releaseChainControllerLock(chainDir, lockOwner);
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(join(tmpdir(), "pi-chains", sessionId), { recursive: true, force: true });
	});

	mkdirSync(join(projectDir, ".pi", "chains"), { recursive: true });
	writeFileSync(chainFile, [
		"name: locked",
		"stages:",
		"  - id: done",
		"    agent: fake-agent",
		"    model: fake/model",
		"    output: done.md",
		"    prompt: Already done",
	].join("\n"));
	mkdirSync(chainDir, { recursive: true });
	writeFileSync(join(chainDir, "status.json"), JSON.stringify({
		id: chainId,
		sessionId,
		chain: "locked",
		chainSource: "project",
		chainScope: "project",
		task: "Do not resume while controlled",
		cwd: projectDir,
		chainDir,
		status: "failed",
		startedAt: "2026-07-10T10:00:00.000Z",
		finishedAt: "2026-07-10T10:01:00.000Z",
		failedStageId: "done",
		failedPhaseId: "done",
		errorMessage: "previous failure",
		chainFilePath: chainFile,
		stages: [{ id: "done", mode: "sequential", phaseIds: ["done"] }],
		phases: [{
			stageId: "done",
			phaseId: "done",
			agent: "fake-agent",
			model: "fake/model",
			status: "complete",
			attempts: [{
				attempt: 1,
				status: "complete",
				startedAt: "2026-07-10T10:00:00.000Z",
				finishedAt: "2026-07-10T10:01:00.000Z",
			}],
			outputs: ["done.md"],
		}],
	}, null, 2));
	assert.equal(chainLock.tryAcquireChainControllerLock(chainDir, lockOwner), true);

	const tools = new Map<string, any>();
	const pi = {
		registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
		registerCommand() {},
		on() {},
		async sendUserMessage() {},
	} as unknown as ExtensionAPI;
	registerBackgroundSubagentTool(pi);
	const ctx = {
		cwd: projectDir,
		hasUI: false,
		mode: "rpc",
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => undefined,
		},
	} as unknown as ExtensionContext;

	const result = await tools.get("chain").execute(
		"resume-call",
		{ action: "resume", chainId },
		new AbortController().signal,
		undefined,
		ctx,
	);
	if (!result.isError) await new Promise((resolve) => setTimeout(resolve, 50));

	const text = result.content.map((item: { text?: string }) => item.text ?? "").join("\n");
	assert.equal(result.isError, true, `expected a persistent-lock rejection, got: ${text}`);
	assert.ok(
		["still_controlled", "lock_held", "controller_lock_held"].includes(result.details?.code)
			|| /(?:still[- ]controlled|controller lock[^\n]*held|lock[^\n]*held)/i.test(text),
		`expected a clear persistent-lock rejection, got: ${text}`,
	);
});
