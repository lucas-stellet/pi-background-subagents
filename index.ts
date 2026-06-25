/**
 * Background Subagents - minimal implementation based on Pi's official example.
 *
 * Differences from the official example:
 * - every subagent runs in the background;
 * - job artifacts are persisted under os.tmpdir()/pi-subagents/<main-session-id>/<job-id>;
 * - when a child process exits, the main agent is notified via pi.sendUserMessage()
 *   so it can inspect and validate the result.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const CUSTOM_TYPE = "background-subagents";
const JOBS_ROOT_NAME = "pi-subagents";
const RESULT_PREVIEW_CHARS = 20_000;
const WIDGET_KEY = "subagent-async";

type JobStatus = "queued" | "running" | "complete" | "failed" | "paused" | "cancelled";

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface JobMetadata {
	id: string;
	sessionId: string;
	agent: string;
	agentSource: "user" | "project";
	task: string;
	cwd: string;
	jobDir: string;
	status: JobStatus;
	startedAt: string;
	finishedAt?: string;
	exitCode?: number | null;
	pid?: number;
	provider?: string;
	model?: string;
	modelSource?: "parent" | "agent" | "settings" | "runtime" | "unknown";
	agentFilePath: string;
	systemPromptMode: AgentConfig["systemPromptMode"];
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	usage: UsageStats;
	lastUpdate?: number;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	toolCount?: number;
	turnCount?: number;
	stopReason?: string;
	errorMessage?: string;
}

interface JobDetails {
	sessionId: string;
	baseDir: string;
	job?: JobMetadata;
	jobs?: JobMetadata[];
	resultPath?: string;
	stdoutPath?: string;
	stderrPath?: string;
	messagesPath?: string;
}

const runningJobs = new Map<string, ChildProcessWithoutNullStreams>();
const cancelledJobs = new Set<string>();
const liveJobs = new Map<string, JobMetadata>();
let lastUiContext: ExtensionContext | null = null;
let widgetRefreshTimer: ReturnType<typeof setInterval> | null = null;

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function safeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function getSessionId(ctx: ExtensionContext): string {
	const explicitId = ctx.sessionManager.getSessionId?.();
	if (explicitId) return safeName(explicitId);

	const sessionFile = ctx.sessionManager.getSessionFile() ?? `ephemeral:${ctx.cwd}`;
	return createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
}

function getBaseDir(sessionId: string): string {
	return path.join(os.tmpdir(), JOBS_ROOT_NAME, sessionId);
}

function findNearestProjectSettingsPath(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "settings.json");
		if (fs.existsSync(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function statusPath(jobDir: string): string {
	return path.join(jobDir, "status.json");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	});
}

function readJson<T>(filePath: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return null;
	}
}

async function writePromptToTempFile(jobDir: string, agentName: string, prompt: string): Promise<string | null> {
	if (!prompt.trim()) return null;
	const promptPath = path.join(jobDir, `system-prompt-${safeName(agentName)}.md`);
	await writeJson(path.join(jobDir, "prompt-meta.json"), { promptPath });
	await withFileMutationQueue(promptPath, async () => {
		await fs.promises.writeFile(promptPath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return promptPath;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

function updateUsageFromMessage(job: JobMetadata, message: Message): void {
	if (message.role !== "assistant") return;
	job.usage.turns++;
	job.turnCount = job.usage.turns;
	job.lastUpdate = Date.now();
	job.lastActivityAt = job.lastUpdate;
	const usage = message.usage;
	if (usage) {
		job.usage.input += usage.input || 0;
		job.usage.output += usage.output || 0;
		job.usage.cacheRead += usage.cacheRead || 0;
		job.usage.cacheWrite += usage.cacheWrite || 0;
		job.usage.cost += usage.cost?.total || 0;
		job.usage.contextTokens = usage.totalTokens || 0;
	}
	if (message.model) {
		job.model = message.model;
		job.provider = inferProvider(message.model) ?? job.provider;
		job.modelSource = "runtime";
	}
	if (message.stopReason) job.stopReason = message.stopReason;
	if (message.errorMessage) job.errorMessage = message.errorMessage;
}

function readJobs(sessionId: string): JobMetadata[] {
	const baseDir = getBaseDir(sessionId);
	if (!fs.existsSync(baseDir)) return [];
	const jobs: JobMetadata[] = [];
	for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const job = readJson<JobMetadata>(statusPath(path.join(baseDir, entry.name)));
		if (job) jobs.push(job);
	}
	return jobs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function formatDuration(ms: number): string {
	if (ms < 1000) return "0s";
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

function inferProvider(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const [provider] = model.split("/", 1);
	if (provider && provider !== model) return provider;
	const normalized = model.toLowerCase();
	if (normalized.includes("claude")) return "anthropic";
	if (normalized.includes("gpt") || normalized.includes("o3") || normalized.includes("o4")) return "openai";
	if (normalized.includes("gemini")) return "google";
	return undefined;
}

function modelPattern(provider: string | undefined, model: string | undefined): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return model;
	return provider ? `${provider}/${model}` : model;
}

function currentContextModel(ctx: ExtensionContext): string | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	return modelPattern(model.provider, model.id);
}

function settingsDefaultModel(ctx: ExtensionContext): string | undefined {
	const globalSettingsPath = path.join(getAgentDir(), "settings.json");
	const settings: Array<Record<string, any>> = [];
	const globalSettings = readJson<Record<string, any>>(globalSettingsPath);
	if (globalSettings) settings.push(globalSettings);

	if (ctx.isProjectTrusted()) {
		const projectSettingsPath = findNearestProjectSettingsPath(ctx.cwd);
		const projectSettings = projectSettingsPath ? readJson<Record<string, any>>(projectSettingsPath) : null;
		if (projectSettings) settings.push(projectSettings);
	}

	const merged = Object.assign({}, ...settings);
	return modelPattern(merged.defaultProvider, merged.defaultModel);
}

function resolveInitialModel(ctx: ExtensionContext, agent: AgentConfig): { model?: string; provider?: string; source: JobMetadata["modelSource"] } {
	const parentModel = currentContextModel(ctx);
	if (parentModel) return { model: parentModel, provider: inferProvider(parentModel), source: "parent" };
	if (agent.model) return { model: agent.model, provider: inferProvider(agent.model), source: "agent" };
	const settingsModel = settingsDefaultModel(ctx);
	if (settingsModel) return { model: settingsModel, provider: inferProvider(settingsModel), source: "settings" };
	return { source: "unknown" };
}

function modelLabel(job: Pick<JobMetadata, "provider" | "model">): string {
	if (job.model) return job.provider && !job.model.startsWith(`${job.provider}/`) ? `${job.provider}/${job.model}` : job.model;
	return job.provider ?? "model unknown";
}

function modelDetail(job: Pick<JobMetadata, "model" | "modelSource">): string {
	if (!job.model) return "unknown";
	return `${job.model}${job.modelSource && job.modelSource !== "unknown" ? ` (${job.modelSource})` : ""}`;
}

function promptModeDetail(job: Partial<Pick<JobMetadata, "systemPromptMode" | "inheritProjectContext" | "inheritSkills">>): string {
	const systemPromptMode = job.systemPromptMode ?? "append";
	const inheritProjectContext = job.inheritProjectContext ?? true;
	const inheritSkills = job.inheritSkills ?? true;
	const parts = [
		systemPromptMode === "replace" ? "replace Pi system prompt" : "append to Pi system prompt",
		inheritProjectContext ? "project context on" : "project context off",
		inheritSkills ? "skills on" : "skills off",
	];
	return parts.join("; ");
}

function compactJobLine(job: JobMetadata, now = Date.now()): string {
	const parts = [job.agent, job.status, modelLabel(job), formatDuration(Math.max(0, now - Date.parse(job.startedAt)))];
	const tokens = job.usage.input + job.usage.output;
	if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
	if (job.turnCount !== undefined) parts.push(`${job.turnCount} turns`);
	if (job.toolCount !== undefined) parts.push(`${job.toolCount} tools`);
	return parts.join(" · ");
}

function formatActivityLabel(lastActivityAt: number | undefined, now = Date.now()): string | undefined {
	if (lastActivityAt === undefined) return undefined;
	const age = Math.max(0, now - lastActivityAt);
	if (age < 1000) return "active now";
	if (age < 60_000) return `active ${Math.floor(age / 1000)}s ago`;
	return `active ${Math.floor(age / 60_000)}m ago`;
}

function runningGlyph(seed?: number): string {
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	return frames[Math.abs(seed ?? Date.now()) % frames.length] ?? "●";
}

function statusGlyph(status: JobStatus): string {
	if (status === "running") return runningGlyph();
	if (status === "queued") return "◦";
	if (status === "complete") return "✓";
	if (status === "paused") return "■";
	if (status === "cancelled") return "⊘";
	return "✗";
}

function widgetActivity(job: JobMetadata, now = Date.now()): string {
	const facts: string[] = [];
	if (job.currentTool && job.currentToolStartedAt !== undefined) facts.push(`${job.currentTool} ${formatDuration(Math.max(0, now - job.currentToolStartedAt))}`);
	else if (job.currentTool) facts.push(job.currentTool);
	const activity = formatActivityLabel(job.lastActivityAt, now);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	if (facts.length) return facts.join(" · ");
	if (job.status === "running") return "thinking…";
	if (job.status === "queued") return "queued…";
	if (job.status === "paused") return "Paused";
	if (job.status === "cancelled") return "Cancelled";
	if (job.status === "failed") return "Failed";
	return "Done";
}

function widgetStats(job: JobMetadata, now = Date.now()): string {
	const parts: string[] = [modelLabel(job), formatDuration(Math.max(0, now - Date.parse(job.startedAt)))];
	const totalTokens = job.usage.input + job.usage.output;
	if (totalTokens > 0) parts.push(`${formatTokens(totalTokens)} tok`);
	if (job.turnCount !== undefined) parts.push(`${job.turnCount} turns`);
	return parts.join(" · ");
}

function formatJobStatusText(job: JobMetadata, verbose = false): string {
	const lines = [
		compactJobLine(job),
		`Job: ${job.id}`,
		`Provider: ${job.provider ?? "unknown"}`,
		`Model: ${modelDetail(job)}`,
		job.lastActivityAt && job.status === "running" ? `Activity: ${formatActivityLabel(job.lastActivityAt)}` : undefined,
		`Prompt: ${promptModeDetail(job)}`,
		job.currentTool ? `Current tool: ${job.currentTool}` : undefined,
		job.errorMessage ? `Error: ${job.errorMessage}` : undefined,
	];
	if (verbose) {
		lines.push(
			`Started: ${job.startedAt}`,
			`Updated: ${job.lastUpdate ? new Date(job.lastUpdate).toISOString() : "n/a"}`,
			`Dir: ${job.jobDir}`,
			`Output: ${path.join(job.jobDir, "result.md")}`,
			`Log: ${path.join(job.jobDir, "stderr.log")}`,
			`Events: ${path.join(job.jobDir, "stdout.jsonl")}`,
		);
	}
	return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function formatJobList(jobs: JobMetadata[], heading = "Active async runs", verbose = false): string {
	if (jobs.length === 0) return `No ${heading.toLowerCase()}.`;
	const lines = [`${heading}: ${jobs.length}`, ""];
	for (const job of jobs) {
		lines.push(`- ${compactJobLine(job)}`);
		lines.push(`  Job: ${job.id}`);
		if (job.lastActivityAt) lines.push(`  Activity: ${formatActivityLabel(job.lastActivityAt)}`);
		if (verbose) lines.push(`  Output: ${path.join(job.jobDir, "result.md")}`);
	}
	return lines.join("\n").trimEnd();
}

function formatAgentList(ctx: ExtensionContext, agents: AgentConfig[], verbose = false): string {
	if (agents.length === 0) return "No agents found.";
	const lines = [`Available agents: ${agents.length}`, ""];
	for (const agent of agents) {
		const model = resolveInitialModel(ctx, agent);
		lines.push(`- ${agent.name} · ${agent.source}`);
		lines.push(`  ${agent.description}`);
		lines.push(`  Provider: ${model.provider ?? "unknown"}`);
		lines.push(`  Model: ${model.model ?? "unknown"}${model.source && model.source !== "unknown" ? ` (${model.source})` : ""}`);
		lines.push(`  Prompt: ${agent.systemPromptMode === "replace" ? "replace Pi system prompt" : "append to Pi system prompt"}; project context ${agent.inheritProjectContext ? "on" : "off"}; skills ${agent.inheritSkills ? "on" : "off"}`);
		if (agent.tools?.length) lines.push(`  Tools: ${agent.tools.join(", ")}`);
		else lines.push("  Tools: default");
		if (verbose) lines.push(`  File: ${agent.filePath}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function activeWidgetJobs(): JobMetadata[] {
	return Array.from(liveJobs.values()).filter((job) => job.status === "queued" || job.status === "running" || job.status === "paused" || job.status === "failed");
}

function visibleRunJobs(jobs: JobMetadata[]): JobMetadata[] {
	return jobs.filter((job) => job.status !== "cancelled");
}

function ensureWidgetRefreshTimer(ctx: ExtensionContext | null = lastUiContext): void {
	if (!ctx?.hasUI) return;
	if (activeWidgetJobs().length === 0) {
		stopWidgetRefreshTimer();
		return;
	}
	if (widgetRefreshTimer) return;
	widgetRefreshTimer = setInterval(() => {
		renderAsyncWidget();
		if (activeWidgetJobs().length === 0) stopWidgetRefreshTimer();
	}, 1000);
	widgetRefreshTimer.unref?.();
}

function stopWidgetRefreshTimer(): void {
	if (!widgetRefreshTimer) return;
	clearInterval(widgetRefreshTimer);
	widgetRefreshTimer = null;
}

function renderAsyncWidget(ctx: ExtensionContext | null = lastUiContext): void {
	if (!ctx?.hasUI) return;
	const jobs = activeWidgetJobs();
	if (jobs.length === 0) {
		try { ctx.ui.setWidget(WIDGET_KEY, undefined); } catch { /* ignore stale UI */ }
		stopWidgetRefreshTimer();
		return;
	}
	ensureWidgetRefreshTimer(ctx);
	const now = Date.now();
	const running = jobs.filter((job) => job.status === "running").length;
	const queued = jobs.filter((job) => job.status === "queued").length;
	const failed = jobs.filter((job) => job.status === "failed").length;
	const paused = jobs.filter((job) => job.status === "paused").length;
	const parts: string[] = [];
	if (running) parts.push(running === 1 ? "1 agent running" : `${running} agents running`);
	if (queued) parts.push(`${queued} queued`);
	if (failed) parts.push(`${failed} failed`);
	if (paused) parts.push(`${paused} paused`);
	const lines = [`${running ? runningGlyph(now) : "○"} Async agents · ${parts.join(", ") || `${jobs.length} total`}`];
	for (const job of jobs.slice(0, 4)) {
		const stats = widgetStats(job, now);
		const status = job.status === "complete" ? "done" : job.status;
		lines.push(`  ${statusGlyph(job.status)} ${job.agent} · ${status}${stats ? ` · ${stats}` : ""} · ${widgetActivity(job, now)}`);
	}
	if (jobs.length > 4) lines.push(`  +${jobs.length - 4} more`);
	try { ctx.ui.setWidget(WIDGET_KEY, lines); } catch { /* ignore stale UI */ }
}

async function startJob(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agent: AgentConfig,
	task: string,
	cwd?: string,
): Promise<JobMetadata> {
	const sessionId = getSessionId(ctx);
	const baseDir = getBaseDir(sessionId);
	const jobId = `subagent-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
	const jobDir = path.join(baseDir, jobId);
	await fs.promises.mkdir(jobDir, { recursive: true });

	const now = Date.now();
	const initialModel = resolveInitialModel(ctx, agent);
	const job: JobMetadata = {
		id: jobId,
		sessionId,
		agent: agent.name,
		agentSource: agent.source,
		task,
		cwd: cwd ?? ctx.cwd,
		jobDir,
		status: "running",
		startedAt: new Date(now).toISOString(),
		exitCode: null,
		provider: initialModel.provider,
		model: initialModel.model,
		modelSource: initialModel.source,
		agentFilePath: agent.filePath,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		usage: emptyUsage(),
		lastUpdate: now,
		lastActivityAt: now,
		toolCount: 0,
		turnCount: 0,
	};

	await writeJson(path.join(jobDir, "task.json"), { agent, task, cwd: job.cwd });
	await writeJson(statusPath(jobDir), job);

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (initialModel.model) args.push("--model", initialModel.model);
	if (!agent.inheritProjectContext) args.push("--no-context-files");
	if (!agent.inheritSkills) args.push("--no-skills");
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	const promptPath = await writePromptToTempFile(jobDir, agent.name, agent.systemPrompt);
	if (promptPath) args.push(agent.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptPath);
	args.push(`Task: ${task}`);

	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd: job.cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
	job.pid = proc.pid;
	await writeJson(statusPath(jobDir), job);
	runningJobs.set(jobId, proc);
	liveJobs.set(jobId, job);
	renderAsyncWidget(ctx);

	const stdoutPath = path.join(jobDir, "stdout.jsonl");
	const stderrPath = path.join(jobDir, "stderr.log");
	const messagesPath = path.join(jobDir, "messages.json");
	const resultPath = path.join(jobDir, "result.md");
	const messages: Message[] = [];
	let stdoutBuffer = "";
	let stderr = "";
	let lineProcessing: Promise<void> = Promise.resolve();
	// Cancellation may be requested by a later tool call while this closure is alive.

	const processLine = async (line: string) => {
		if (!line.trim()) return;
		await fs.promises.appendFile(stdoutPath, `${line}\n`, "utf-8");
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		if (event.type === "tool_execution_start") {
			job.currentTool = event.toolName;
			job.currentToolArgs = event.args ? JSON.stringify(event.args).slice(0, 500) : undefined;
			job.currentToolStartedAt = Date.now();
			job.lastUpdate = job.currentToolStartedAt;
			job.lastActivityAt = job.currentToolStartedAt;
			await writeJson(statusPath(jobDir), job);
			renderAsyncWidget();
		}

		if (event.type === "tool_execution_end") {
			job.toolCount = (job.toolCount ?? 0) + 1;
			job.currentTool = undefined;
			job.currentToolArgs = undefined;
			job.currentToolStartedAt = undefined;
			job.lastUpdate = Date.now();
			job.lastActivityAt = job.lastUpdate;
			await writeJson(statusPath(jobDir), job);
			renderAsyncWidget();
		}

		if (event.type === "message_end" && event.message) {
			const message = event.message as Message;
			messages.push(message);
			updateUsageFromMessage(job, message);
			await writeJson(messagesPath, messages);
			await writeJson(statusPath(jobDir), job);
			renderAsyncWidget();
		}
	};

	proc.stdout.on("data", (data) => {
		stdoutBuffer += data.toString();
		const lines = stdoutBuffer.split("\n");
		stdoutBuffer = lines.pop() || "";
		for (const line of lines) lineProcessing = lineProcessing.then(() => processLine(line));
	});

	proc.stderr.on("data", (data) => {
		const text = data.toString();
		stderr += text;
		void fs.promises.appendFile(stderrPath, text, "utf-8");
	});

	proc.on("error", async (error) => {
		job.status = "failed";
		job.errorMessage = error.message;
		job.finishedAt = new Date().toISOString();
		await writeJson(statusPath(jobDir), job);
	});

	proc.on("close", async (code, signal) => {
		runningJobs.delete(jobId);
		const wasCancelled = cancelledJobs.delete(jobId);
		if (stdoutBuffer.trim()) lineProcessing = lineProcessing.then(() => processLine(stdoutBuffer));
		await lineProcessing;

		const finalOutput = getFinalOutput(messages);
		await fs.promises.writeFile(resultPath, finalOutput || "(no output)\n", "utf-8");
		await writeJson(messagesPath, messages);

		job.exitCode = code;
		job.finishedAt = new Date().toISOString();
		job.lastUpdate = Date.now();
		job.currentTool = undefined;
		job.currentToolArgs = undefined;
		job.currentToolStartedAt = undefined;
		if (wasCancelled) job.status = "cancelled";
		else if (signal) job.status = "failed";
		else if ((job.exitCode ?? 0) !== 0 || job.stopReason === "error" || job.stopReason === "aborted") job.status = "failed";
		else job.status = "complete";
		if (!job.errorMessage && stderr.trim() && job.status === "failed") job.errorMessage = stderr.trim().slice(0, 4000);
		await writeJson(statusPath(jobDir), job);
		if (job.status === "complete" || job.status === "cancelled") liveJobs.delete(jobId);
		renderAsyncWidget();
		if (activeWidgetJobs().length === 0) stopWidgetRefreshTimer();

		const preview = finalOutput.length > RESULT_PREVIEW_CHARS ? `${finalOutput.slice(0, RESULT_PREVIEW_CHARS)}\n\n[truncated preview]` : finalOutput;
		try {
			const elapsed = job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : 0;
			const totalTokens = job.usage.input + job.usage.output;
			pi.sendUserMessage(
				[
					`${job.agent} finished · ${job.status} · ${formatDuration(Math.max(0, elapsed))}`,
					`Job: ${job.id}`,
					`Provider: ${job.provider ?? "unknown"}`,
					`Model: ${modelDetail(job)}`,
					`Prompt: ${promptModeDetail(job)}`,
					totalTokens > 0 ? `Tokens: ${formatTokens(totalTokens)}` : undefined,
					job.toolCount !== undefined ? `Tools: ${job.toolCount}` : undefined,
					job.exitCode !== null && job.exitCode !== undefined ? `Exit code: ${job.exitCode}` : undefined,
					"",
					"Validate the result before continuing. Use subagent result with this jobId to inspect the saved output.",
					"",
					preview ? `Result preview:\n\n${preview}` : "Result preview: (no output)",
				].filter((line): line is string => Boolean(line)).join("\n"),
				{ deliverAs: "followUp" },
			);
		} catch {
			// The parent runtime may have been shut down/reloaded; artifacts are still on disk.
		}
	});

	return job;
}

const ActionSchema = StringEnum(["start", "status", "result", "list", "list-agents", "cancel"] as const, {
	description: 'Action to perform. start launches one background agent; list-agents shows available agents including prompt mode, project-context inheritance, skills inheritance, and tools; status/result/cancel inspect a job; list shows prior runs. Default is "start" when agent and task are provided.',
	default: "start",
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: `Which agent directories to use. Default: "user" (${path.join(getAgentDir(), "agents")}). Use "both" to include project-local agents from ${CONFIG_DIR_NAME}/agents.`,
	default: "user",
});

const SubagentParams = Type.Object({
	action: Type.Optional(ActionSchema),
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (start action). Use action=list-agents first to inspect prompt mode, context/skills inheritance, model, and tools." })),
	task: Type.Optional(Type.String({ description: "Task to delegate (start action). The selected agent's frontmatter controls whether its prompt replaces or appends to Pi's default prompt." })),
	jobId: Type.Optional(Type.String({ description: "Background job id (status/result/cancel actions). Status output includes the prompt mode used for the run." })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process" })),
	verbose: Type.Optional(Type.Boolean({ description: "Include debug paths and full artifact details in status/list output. Default: false.", default: false })),
});

export default function (pi: ExtensionAPI) {
	registerBackgroundSubagentTool(pi);
}

export function registerBackgroundSubagentTool(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		lastUiContext = ctx;
		renderAsyncWidget(ctx);
	});

	pi.on("session_shutdown", () => {
		stopWidgetRefreshTimer();
		lastUiContext = null;
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Start and manage background subagents with isolated context.",
			"All subagents run in background and save artifacts under the OS temp directory.",
			"Actions: start, status, result, list, list-agents, cancel.",
			"Agent frontmatter controls prompt isolation: systemPromptMode=replace uses --system-prompt and does not include Pi's default system prompt; systemPromptMode=append uses --append-system-prompt.",
			"inheritProjectContext=false passes --no-context-files; inheritSkills=false passes --no-skills.",
			"Use list-agents to inspect each agent's prompt mode, inherited context/skills, model, and tools before launching.",
			`Default agent scope is user (${path.join(getAgentDir(), "agents")}).`,
			`Project agents live in ${CONFIG_DIR_NAME}/agents and require agentScope=project or both.`,
		].join(" "),
		promptSnippet: "Start or inspect background subagents with isolated context",
		promptGuidelines: [
			"Use subagent to delegate codebase research or focused tasks to background agents when testing this background-only subagent extension.",
			"Use action=\"list-agents\" when you need to confirm available subcommands/agents or whether an agent replaces or appends to Pi's system prompt.",
			"Prefer agents with systemPromptMode=replace for tightly scoped roles to avoid inheriting Pi's full default system prompt unnecessarily.",
			"After subagent reports a completed background job, use subagent with action=\"result\" to inspect and validate the result before continuing.",
		],
		parameters: SubagentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastUiContext = ctx;
			const sessionId = getSessionId(ctx);
			const baseDir = getBaseDir(sessionId);
			const action = params.action ?? (params.agent && params.task ? "start" : "list");

			if (action === "list") {
				const jobs = visibleRunJobs(readJobs(sessionId));
				return { content: [{ type: "text", text: formatJobList(jobs, "Async runs", params.verbose ?? false) }], details: { sessionId, baseDir, jobs } };
			}

			if (action === "list-agents") {
				const agentScope: AgentScope = params.agentScope ?? "user";
				const discovery = discoverAgents(ctx.cwd, agentScope);
				return {
					content: [{ type: "text", text: formatAgentList(ctx, discovery.agents, params.verbose ?? false) }],
					details: { sessionId, baseDir, agents: discovery.agents, projectAgentsDir: discovery.projectAgentsDir },
				};
			}

			if (action === "status" || action === "result" || action === "cancel") {
				if (!params.jobId) {
					if (action === "status") {
						const activeJobs = readJobs(sessionId).filter((job) => job.status === "queued" || job.status === "running" || job.status === "paused");
						return { content: [{ type: "text", text: formatJobList(activeJobs, "Active async runs", params.verbose ?? false) }], details: { sessionId, baseDir, jobs: activeJobs } };
					}
					return {
						content: [{ type: "text", text: `jobId is required for action "${action}".` }],
						details: { sessionId, baseDir },
					};
				}
				const jobDir = path.join(baseDir, safeName(params.jobId));
				const job = readJson<JobMetadata>(statusPath(jobDir));
				if (!job) {
					return {
						content: [{ type: "text", text: `Job not found in this session: ${params.jobId}` }],
						details: { sessionId, baseDir },
						isError: true,
					};
				}

				if (action === "cancel") {
					const proc = runningJobs.get(job.id);
					if (!proc || job.status !== "running") {
						return { content: [{ type: "text", text: `Job ${job.id} is not running.` }], details: { sessionId, baseDir, job } };
					}
					cancelledJobs.add(job.id);
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
					job.status = "cancelled";
					job.finishedAt = new Date().toISOString();
					job.lastUpdate = Date.now();
					liveJobs.delete(job.id);
					await writeJson(statusPath(jobDir), job);
					renderAsyncWidget(ctx);
					return { content: [{ type: "text", text: `Cancellation requested for ${job.id}.` }], details: { sessionId, baseDir, job } };
				}

				if (action === "status") {
					return {
						content: [{ type: "text", text: formatJobStatusText(job, params.verbose ?? false) }],
						details: { sessionId, baseDir, job },
					};
				}

				const resultPath = path.join(jobDir, "result.md");
				const stdoutPath = path.join(jobDir, "stdout.jsonl");
				const stderrPath = path.join(jobDir, "stderr.log");
				const messagesPath = path.join(jobDir, "messages.json");
				let result = "";
				try {
					result = fs.readFileSync(resultPath, "utf-8");
				} catch {
					result = job.status === "running" ? "(job is still running; result.md is not available yet)" : "(no result.md found)";
				}
				return {
					content: [{ type: "text", text: result }],
					details: { sessionId, baseDir, job, resultPath, stdoutPath, stderrPath, messagesPath },
				};
			}

			if (!params.agent || !params.task) {
				return {
					content: [{ type: "text", text: "agent and task are required for action \"start\"." }],
					details: { sessionId, baseDir },
					isError: true,
				};
			}

			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agent = discovery.agents.find((a) => a.name === params.agent);
			if (!agent) {
				const available = discovery.agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Unknown agent: ${params.agent}. Available agents: ${available}.` }],
					details: { sessionId, baseDir },
					isError: true,
				};
			}

			if (agent.source === "project" && (params.confirmProjectAgents ?? true) && ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Run project-local subagent?",
					`Agent: ${agent.name}\nSource: ${agent.filePath}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				if (!ok) {
					return { content: [{ type: "text", text: "Canceled: project-local agent not approved." }], details: { sessionId, baseDir } };
				}
			}

			const job = await startJob(pi, ctx, agent, params.task, params.cwd);
			pi.appendEntry(CUSTOM_TYPE, { event: "started", job });
			return {
				content: [
					{
						type: "text",
						text: [
							`Started ${job.agent} · ${job.status}`,
							`Job: ${job.id}`,
							`Provider: ${job.provider ?? "unknown"}`,
							`Model: ${modelDetail(job)}`,
							`Prompt: ${promptModeDetail(job)}`,
							"",
							"You'll be notified when it finishes.",
						].join("\n"),
					},
				],
				details: { sessionId, baseDir, job },
			};
		},
	});
}
