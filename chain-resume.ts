import { createHash } from "node:crypto";
import type { ChainConfig, ChainScope } from "./chains.ts";

export function computeChainDefinitionFingerprint(chain: ChainConfig): string {
	const contract = {
		name: chain.name,
		stages: chain.stages.map((stage) => ({
			id: stage.id,
			mode: stage.mode,
			reads: stage.reads,
			phases: stage.phases.map((phase) => ({
				id: phase.id,
				agent: phase.agent,
				model: phase.model,
				tools: phase.tools,
				reads: phase.reads,
				outputs: phase.outputs ?? (phase.output ? [phase.output] : []),
				prompt: phase.prompt,
			})),
		})),
	};
	return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

export type ChainDefinitionCompatibility =
	| { compatible: true }
	| { compatible: false; code: "definition_changed" };

export function checkChainDefinitionCompatibility(
	persistedFingerprint: string | undefined,
	chain: ChainConfig,
): ChainDefinitionCompatibility {
	if (persistedFingerprint && persistedFingerprint !== computeChainDefinitionFingerprint(chain)) {
		return { compatible: false, code: "definition_changed" };
	}
	return { compatible: true };
}

export function resolveChainScopeForResume(
	chainRun: { chainScope?: ChainScope },
	explicitScope?: ChainScope,
): ChainScope {
	return explicitScope ?? chainRun.chainScope ?? "user";
}

export type ChainResumeEligibility =
	| { eligible: true }
	| { eligible: false; code: "already_complete" | "still_running"; message: string };

export function checkChainResumeEligibility(
	chainRun: { id: string; status: string },
	runtime?: { controllerAlive: boolean; phaseProcessAlive: boolean },
): ChainResumeEligibility {
	if (runtime?.controllerAlive || runtime?.phaseProcessAlive) {
		return {
			eligible: false,
			code: "still_running",
			message: `Chain ${chainRun.id} is still running and cannot be resumed.`,
		};
	}
	if (chainRun.status === "complete") {
		return {
			eligible: false,
			code: "already_complete",
			message: `Chain ${chainRun.id} is already complete and cannot be resumed.`,
		};
	}
	return { eligible: true };
}

export interface ResumableChainRun {
	status: string;
	errorMessage?: string;
	failedStageId?: string;
	failedPhaseId?: string;
	finishedAt?: string;
}

export function prepareChainRunForResume<T extends ResumableChainRun>(chainRun: T): T {
	chainRun.status = "running";
	chainRun.errorMessage = undefined;
	chainRun.failedStageId = undefined;
	chainRun.failedPhaseId = undefined;
	chainRun.finishedAt = undefined;
	return chainRun;
}

export interface ResumeRepairPhase {
	status: string;
	attempts: Array<{ status: string; finishedAt?: string; errorMessage?: string }>;
}

export interface ResumeRepairChain {
	phases: ResumeRepairPhase[];
}

export function repairInterruptedChainForResume(
	chainRun: ResumeRepairChain,
	runtime: { controllerAlive: boolean; phaseProcessAlive: boolean; interruptedAt: string },
): ResumeRepairChain {
	if (runtime.controllerAlive || runtime.phaseProcessAlive) {
		throw new Error("Cannot repair an interrupted chain while its controller or phase process is still running.");
	}
	for (const phase of chainRun.phases) {
		if (phase.status !== "running") continue;
		phase.status = "failed";
		const attempt = phase.attempts.at(-1);
		if (attempt?.status !== "running") continue;
		attempt.status = "failed";
		attempt.finishedAt = runtime.interruptedAt;
		attempt.errorMessage = "Interrupted chain attempt repaired during resume; no live controller or phase process was found.";
	}
	return chainRun;
}
