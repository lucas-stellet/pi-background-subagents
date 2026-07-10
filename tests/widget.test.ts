import assert from "node:assert/strict";
import test from "node:test";
import { buildAsyncWidgetSection, clearFinishedWidgetRuns, formatAgentDuration, formatElapsedMinutes } from "../index.ts";

function runningChain(startedAt: string, id = "chain-1") {
	return {
		id,
		sessionId: "session-1",
		chain: "review",
		chainSource: "user" as const,
		task: "Review the change",
		cwd: "/tmp/project",
		chainDir: `/tmp/${id}`,
		status: "running" as const,
		startedAt,
		chainFilePath: "/tmp/review.chain.yaml",
		stages: [],
		phases: [],
	};
}

test("formats agent duration at 30-second then minute granularity", () => {
	assert.equal(formatAgentDuration(0), "<30s");
	assert.equal(formatAgentDuration(29_999), "<30s");
	assert.equal(formatAgentDuration(30_000), "30s");
	assert.equal(formatAgentDuration(59_999), "30s");
	assert.equal(formatAgentDuration(60_000), "1m");
	assert.equal(formatAgentDuration(119_999), "1m");
	assert.equal(formatAgentDuration(120_000), "2m");
	assert.equal(formatAgentDuration(3_780_000), "1h 3m");
});

test("formats elapsed chain time at minute granularity", () => {
	assert.equal(formatElapsedMinutes(0), "<1m");
	assert.equal(formatElapsedMinutes(59_999), "<1m");
	assert.equal(formatElapsedMinutes(60_000), "1m");
	assert.equal(formatElapsedMinutes(3_780_000), "1h 3m");
});

test("shows and updates elapsed time after a single running chain", () => {
	const startedAt = "2026-07-09T12:00:00.000Z";
	const chain = runningChain(startedAt);

	const atThreeMinutes = buildAsyncWidgetSection([], [chain], Date.parse(startedAt) + 180_000);
	const atFourMinutes = buildAsyncWidgetSection([], [chain], Date.parse(startedAt) + 240_000);

	assert.equal(atThreeMinutes.lines[0], "◆ Async agents · 1 chain running · 3m elapsed");
	assert.equal(atFourMinutes.lines[0], "◆ Async agents · 1 chain running · 4m elapsed");
});

test("clears only finished jobs and chains from the widget state", () => {
	const jobs = new Map([
		["queued", { status: "queued" }],
		["running", { status: "running" }],
		["paused", { status: "paused" }],
		["complete", { status: "complete" }],
		["failed", { status: "failed" }],
		["cancelled", { status: "cancelled" }],
	]);
	const chains = new Map([
		["running", { status: "running" }],
		["complete", { status: "complete" }],
		["failed", { status: "failed" }],
	]);

	const cleared = clearFinishedWidgetRuns(jobs as never, chains as never);

	assert.deepEqual(cleared, { jobs: 3, chains: 2, total: 5 });
	assert.deepEqual([...jobs.keys()], ["queued", "running", "paused"]);
	assert.deepEqual([...chains.keys()], ["running"]);
});

test("freezes a failed agent duration at finishedAt", () => {
	const startedAt = "2026-07-09T12:00:00.000Z";
	const job = {
		id: "job-1",
		sessionId: "session-1",
		agent: "reviewer",
		agentSource: "user" as const,
		task: "Review",
		cwd: "/tmp/project",
		jobDir: "/tmp/job-1",
		status: "failed" as const,
		startedAt,
		finishedAt: "2026-07-09T12:01:00.000Z",
		agentFilePath: "/tmp/reviewer.md",
		systemPromptMode: "replace" as const,
		inheritProjectContext: false,
		inheritSkills: false,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};

	const section = buildAsyncWidgetSection([job], [], Date.parse(startedAt) + 3_600_000);

	assert.match(section.lines[1]!, /reviewer · failed · model unknown · 1m · Failed/);
	assert.equal(section.lines.at(-1), "  /subagents-clear to clear finished");
});

test("freezes a completed chain phase duration at finishedAt", () => {
	const startedAt = "2026-07-09T12:00:00.000Z";
	const chain = {
		...runningChain(startedAt),
		status: "complete" as const,
		finishedAt: "2026-07-09T12:01:00.000Z",
		stages: [{ id: "review", mode: "sequential" as const, phaseIds: ["review"] }],
		phases: [{
			stageId: "review",
			phaseId: "review",
			agent: "reviewer",
			status: "complete" as const,
			attempts: [{
				attempt: 1,
				status: "complete" as const,
				startedAt,
				finishedAt: "2026-07-09T12:01:00.000Z",
			}],
			outputs: [],
		}],
	};

	const section = buildAsyncWidgetSection([], [chain], Date.parse(startedAt) + 3_600_000);

	assert.match(section.lines[2]!, /review · complete · model unknown · ran 1m/);
});

test("does not imply one elapsed duration when multiple chains are running", () => {
	const startedAt = "2026-07-09T12:00:00.000Z";
	const section = buildAsyncWidgetSection(
		[],
		[runningChain(startedAt, "chain-1"), runningChain(startedAt, "chain-2")],
		Date.parse(startedAt) + 180_000,
	);

	assert.equal(section.lines[0], "◆ Async agents · 2 chains running");
});
