import assert from "node:assert/strict";
import test from "node:test";
import {
	CONTACT_SUPERVISOR_TOOL,
	createSubagentIntercomBridge,
	prepareSubagentIntercom,
} from "../intercom.ts";

const metadata = {
	orchestratorTarget: "019f49ba-800e-732f-840b-9001637a6159",
	runId: "chain-123",
	agent: "red",
	childIndex: 2,
};

test("creates the pi-intercom child metadata expected by contact_supervisor", () => {
	const bridge = createSubagentIntercomBridge(metadata);

	assert.deepEqual(bridge.env, {
		PI_SUBAGENT_ORCHESTRATOR_TARGET: metadata.orchestratorTarget,
		PI_SUBAGENT_RUN_ID: metadata.runId,
		PI_SUBAGENT_CHILD_AGENT: metadata.agent,
		PI_SUBAGENT_CHILD_INDEX: "2",
	});
	assert.match(bridge.instruction, /reason: "need_decision"/);
	assert.match(bridge.instruction, /wait for the reply/);
});

test("adds contact_supervisor to an explicit child tool allowlist", () => {
	const prepared = prepareSubagentIntercom(metadata, ["read", "write"]);

	assert.ok(prepared.bridge);
	assert.deepEqual(prepared.tools, ["read", "write", CONTACT_SUPERVISOR_TOOL]);
});

test("does not duplicate contact_supervisor", () => {
	const tools = ["read", CONTACT_SUPERVISOR_TOOL];

	assert.deepEqual(prepareSubagentIntercom(metadata, tools).tools, tools);
});

test("keeps the default tool surface when no explicit allowlist exists", () => {
	assert.equal(prepareSubagentIntercom(metadata, undefined).tools, undefined);
});

test("fails closed when the parent has no targetable session id", () => {
	const tools = ["read", "write"];
	const prepared = prepareSubagentIntercom(undefined, tools);

	assert.equal(prepared.bridge, undefined);
	assert.deepEqual(prepared.tools, tools);
});
