export const CONTACT_SUPERVISOR_TOOL = "contact_supervisor";

export interface SubagentIntercomMetadata {
	orchestratorTarget: string;
	runId: string;
	agent: string;
	childIndex: number;
}

export interface SubagentIntercomBridge {
	env: Record<string, string>;
	instruction: string;
}

export function createSubagentIntercomBridge(metadata: SubagentIntercomMetadata): SubagentIntercomBridge {
	return {
		env: {
			PI_SUBAGENT_ORCHESTRATOR_TARGET: metadata.orchestratorTarget,
			PI_SUBAGENT_RUN_ID: metadata.runId,
			PI_SUBAGENT_CHILD_AGENT: metadata.agent,
			PI_SUBAGENT_CHILD_INDEX: String(metadata.childIndex),
		},
		instruction: [
			"Supervisor coordination",
			"",
			"A safe supervisor target is available through contact_supervisor.",
			'- When blocked or needing a product, architecture, API, scope, or validation decision, call contact_supervisor with reason: "need_decision" and wait for the reply before continuing.',
			'- Use reason: "progress_update" only for meaningful discoveries that change the plan.',
			"- Do not use contact_supervisor for routine completion handoffs; return the normal task result instead.",
		].join("\n"),
	};
}

export function addContactSupervisorTool(tools: string[] | undefined): string[] | undefined {
	if (!tools || tools.includes(CONTACT_SUPERVISOR_TOOL)) return tools;
	return [...tools, CONTACT_SUPERVISOR_TOOL];
}

export function prepareSubagentIntercom(
	metadata: SubagentIntercomMetadata | undefined,
	tools: string[] | undefined,
): { bridge?: SubagentIntercomBridge; tools: string[] | undefined } {
	if (!metadata) return { tools };
	return {
		bridge: createSubagentIntercomBridge(metadata),
		tools: addContactSupervisorTool(tools),
	};
}
