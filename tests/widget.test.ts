import assert from "node:assert/strict";
import test from "node:test";
import { buildAsyncWidgetSection, formatElapsedMinutes } from "../index.ts";

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

test("does not imply one elapsed duration when multiple chains are running", () => {
	const startedAt = "2026-07-09T12:00:00.000Z";
	const section = buildAsyncWidgetSection(
		[],
		[runningChain(startedAt, "chain-1"), runningChain(startedAt, "chain-2")],
		Date.parse(startedAt) + 180_000,
	);

	assert.equal(section.lines[0], "◆ Async agents · 2 chains running");
});
