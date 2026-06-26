import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type ChainScope = "user" | "project" | "both";
export type ChainSource = "user" | "project";
export type ChainMode = "sequential" | "parallel";

export interface ChainPhase {
	id: string;
	agent: string;
	reads: string[];
	output?: string;
	outputs?: string[];
	outputMode?: string;
	progress?: boolean;
	tools?: string[];
	prompt: string;
}

export interface ChainStage {
	id: string;
	mode: ChainMode;
	reads: string[];
	phases: ChainPhase[];
}

export interface ChainConfig {
	name: string;
	description: string;
	stages: ChainStage[];
	source: ChainSource;
	filePath: string;
}

export interface ChainDiscoveryResult {
	chains: ChainConfig[];
	projectChainsDir: string | null;
}

function isDirectory(filePath: string): boolean {
	try { return fs.statSync(filePath).isDirectory(); } catch { return false; }
}

function findNearestProjectChainsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "chains");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function parseScalar(value: string): any {
	const trimmed = value.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed === "[]") return [];
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
	return trimmed;
}

interface Line { indent: number; text: string; raw: string }

function preprocess(content: string): Line[] {
	return content.replace(/^---\s*\n/, "").replace(/\n---\s*$/, "").split(/\r?\n/).map((raw) => ({ raw, indent: raw.match(/^ */)?.[0].length ?? 0, text: raw.trim() }));
}

function parseBlock(lines: Line[], index: number, parentIndent: number): { value: string; index: number } {
	const out: string[] = [];
	while (index < lines.length && (lines[index].indent > parentIndent || !lines[index].text)) {
		out.push(lines[index].text ? lines[index].raw.slice(parentIndent + 2) : "");
		index++;
	}
	return { value: out.join("\n").replace(/\n+$/, ""), index };
}

function parseStringList(lines: Line[], index: number, parentIndent: number): { value: string[]; index: number } {
	const values: string[] = [];
	while (index < lines.length && lines[index].indent > parentIndent) {
		const text = lines[index].text;
		if (text.startsWith("- ")) values.push(String(parseScalar(text.slice(2))));
		index++;
	}
	return { value: values, index };
}

function readKeyValue(line: string): { key: string; value: string } | null {
	const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
	if (!match) return null;
	return { key: match[1], value: match[2] ?? "" };
}

function parsePhase(lines: Line[], index: number, itemIndent: number, inheritedReads: string[] = []): { phase: ChainPhase; index: number } {
	const first = lines[index].text.slice(2);
	const phase: ChainPhase = { id: "", agent: "", reads: [...inheritedReads], prompt: "" };
	if (first) {
		const kv = readKeyValue(first);
		if (kv) (phase as any)[kv.key] = parseScalar(kv.value);
	}
	index++;
	while (index < lines.length && lines[index].indent > itemIndent) {
		const kv = readKeyValue(lines[index].text);
		if (!kv) { index++; continue; }
		if (kv.value === "|") {
			const block = parseBlock(lines, index + 1, lines[index].indent);
			(phase as any)[kv.key] = block.value;
			index = block.index;
		} else if (!kv.value && (kv.key === "reads" || kv.key === "outputs" || kv.key === "tools")) {
			const list = parseStringList(lines, index + 1, lines[index].indent);
			(phase as any)[kv.key] = list.value;
			index = list.index;
		} else {
			(phase as any)[kv.key] = parseScalar(kv.value);
			index++;
		}
	}
	phase.id = String(phase.id || phase.agent);
	phase.agent = String(phase.agent || phase.id);
	phase.reads = Array.from(new Set([...(inheritedReads ?? []), ...normalizeList((phase as any).reads)]));
	phase.tools = (phase as any).tools ? normalizeList((phase as any).tools) : undefined;
	phase.outputs = (phase as any).outputs ? normalizeList((phase as any).outputs) : undefined;
	if ((phase as any).output) phase.output = String((phase as any).output);
	if (!phase.id || !phase.agent) throw new Error(`Invalid phase missing id/agent near line ${index}`);
	return { phase, index };
}

function normalizeList(value: unknown): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value.map(String).filter(Boolean);
	return String(value).split(",").map((x) => x.trim()).filter(Boolean);
}

function parseStages(lines: Line[], index: number, parentIndent: number): { stages: ChainStage[]; index: number } {
	const stages: ChainStage[] = [];
	while (index < lines.length && lines[index].indent > parentIndent) {
		if (!lines[index].text.startsWith("- ")) { index++; continue; }
		const itemIndent = lines[index].indent;
		const first = lines[index].text.slice(2);
		const stage: ChainStage = { id: "", mode: "sequential", reads: [], phases: [] };
		if (first) {
			const kv = readKeyValue(first);
			if (kv) (stage as any)[kv.key] = parseScalar(kv.value);
		}
		index++;
		while (index < lines.length && lines[index].indent > itemIndent) {
			const kv = readKeyValue(lines[index].text);
			if (!kv) { index++; continue; }
			if (kv.key === "phases") {
				index++;
				while (index < lines.length && lines[index].indent > itemIndent + 2) {
					if (lines[index].text.startsWith("- ")) {
						const parsed = parsePhase(lines, index, lines[index].indent, normalizeList((stage as any).reads));
						stage.phases.push(parsed.phase);
						index = parsed.index;
					} else index++;
				}
			} else if (kv.value === "|") {
				const block = parseBlock(lines, index + 1, lines[index].indent);
				(stage as any)[kv.key] = block.value;
				index = block.index;
			} else if (!kv.value && (kv.key === "reads" || kv.key === "outputs" || kv.key === "tools")) {
				const list = parseStringList(lines, index + 1, lines[index].indent);
				(stage as any)[kv.key] = list.value;
				index = list.index;
			} else {
				(stage as any)[kv.key] = parseScalar(kv.value);
				index++;
			}
		}
		stage.id = String((stage as any).id || (stage as any).agent || `stage-${stages.length + 1}`);
		stage.mode = (stage as any).mode === "parallel" ? "parallel" : "sequential";
		stage.reads = normalizeList((stage as any).reads);
		if (stage.phases.length === 0) {
			stage.phases.push({
				id: stage.id,
				agent: String((stage as any).agent || stage.id),
				reads: stage.reads,
				output: (stage as any).output ? String((stage as any).output) : undefined,
				outputs: (stage as any).outputs ? normalizeList((stage as any).outputs) : undefined,
				outputMode: (stage as any).outputMode ? String((stage as any).outputMode) : undefined,
				progress: Boolean((stage as any).progress),
				tools: (stage as any).tools ? normalizeList((stage as any).tools) : undefined,
				prompt: String((stage as any).prompt || ""),
			});
		}
		stages.push(stage);
	}
	return { stages, index };
}

function validatePhase(phase: ChainPhase, filePath: string): void {
	if (!phase.id) throw new Error(`Chain phase missing id in ${filePath}`);
	if (!phase.agent) throw new Error(`Chain phase ${phase.id} missing agent in ${filePath}`);
	const outputs = phase.outputs ?? (phase.output ? [phase.output] : []);
	if (outputs.length === 0) throw new Error(`Chain phase ${phase.id} must declare output or outputs in ${filePath}`);
	for (const output of outputs) {
		if (path.isAbsolute(output) || output.includes("..")) throw new Error(`Invalid chain output path ${output} in ${filePath}`);
	}
	for (const input of phase.reads) {
		if (path.isAbsolute(input) || input.includes("..")) throw new Error(`Invalid chain read path ${input} in ${filePath}`);
	}
}

function validateChain(chain: ChainConfig): ChainConfig {
	const produced = new Set<string>();
	for (const stage of chain.stages) {
		const stageOutputs = new Set<string>();
		for (const phase of stage.phases) {
			validatePhase(phase, chain.filePath);
			for (const read of phase.reads) {
				if (!produced.has(read)) throw new Error(`Chain phase ${phase.id} reads unavailable input ${read} in ${chain.filePath}`);
			}
			for (const output of phase.outputs ?? (phase.output ? [phase.output] : [])) stageOutputs.add(output);
		}
		for (const output of stageOutputs) produced.add(output);
	}
	return chain;
}

export function parseChainYaml(content: string, filePath: string, source: ChainSource): ChainConfig {
	const lines = preprocess(content);
	const root: any = {};
	let index = 0;
	while (index < lines.length) {
		const kv = readKeyValue(lines[index].text);
		if (!kv) { index++; continue; }
		if (kv.key === "stages") {
			const parsed = parseStages(lines, index + 1, lines[index].indent);
			root.stages = parsed.stages;
			index = parsed.index;
		} else if (kv.value === "|") {
			const block = parseBlock(lines, index + 1, lines[index].indent);
			root[kv.key] = block.value;
			index = block.index;
		} else {
			root[kv.key] = parseScalar(kv.value);
			index++;
		}
	}
	if (!root.name) throw new Error(`Chain missing name: ${filePath}`);
	if (!root.stages?.length) throw new Error(`Chain missing stages: ${filePath}`);
	return validateChain({ name: String(root.name), description: String(root.description || ""), stages: root.stages, source, filePath });
}

function loadChainsFromDir(dir: string, source: ChainSource): ChainConfig[] {
	if (!fs.existsSync(dir)) return [];
	const chains: ChainConfig[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		if (!entry.name.endsWith(".chain.yaml") && !entry.name.endsWith(".chain.yml")) continue;
		const filePath = path.join(dir, entry.name);
		try { chains.push(parseChainYaml(fs.readFileSync(filePath, "utf-8"), filePath, source)); } catch { /* ignore invalid chain */ }
	}
	return chains;
}

export function discoverChains(cwd: string, scope: ChainScope): ChainDiscoveryResult {
	const userDir = path.join(getAgentDir(), "chains");
	const projectChainsDir = findNearestProjectChainsDir(cwd);
	const userChains = scope === "project" ? [] : loadChainsFromDir(userDir, "user");
	const projectChains = scope === "user" || !projectChainsDir ? [] : loadChainsFromDir(projectChainsDir, "project");
	const chainMap = new Map<string, ChainConfig>();
	if (scope === "both") {
		for (const chain of userChains) chainMap.set(chain.name, chain);
		for (const chain of projectChains) chainMap.set(chain.name, chain);
	} else if (scope === "user") for (const chain of userChains) chainMap.set(chain.name, chain);
	else for (const chain of projectChains) chainMap.set(chain.name, chain);
	return { chains: Array.from(chainMap.values()), projectChainsDir };
}
