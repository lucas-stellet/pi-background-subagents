import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_STDOUT_SEGMENT_BYTES = 2 * 1024 * 1024;
export const DEFAULT_STDOUT_SEGMENT_COUNT = 5;
export const DEFAULT_ARTIFACT_USAGE_WARNING_BYTES = 50 * 1024 ** 3;

export interface ArtifactRoots {
	baseDir: string;
	subagentsDir: string;
	chainsDir: string;
}

export function resolveArtifactRoots(options: { home?: string } = {}): ArtifactRoots {
	const baseDir = path.join(options.home ?? os.homedir(), ".local", "state", "pi-background-subagents");
	return {
		baseDir,
		subagentsDir: path.join(baseDir, "subagents"),
		chainsDir: path.join(baseDir, "chains"),
	};
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
	if (process.platform === "win32") return;
	const stat = await fs.promises.lstat(directory);
	if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link artifact directory: ${directory}`);
	if (typeof process.getuid !== "function" || stat.uid === process.getuid()) {
		await fs.promises.chmod(directory, 0o700);
	}
}

/** Tighten owner-only mode on an extension-created sensitive file when the platform supports it. */
export async function ensurePrivateFile(filePath: string): Promise<void> {
	if (process.platform !== "win32") await fs.promises.chmod(filePath, 0o600);
}

export function isDiskPressureError(error: unknown): boolean {
	const value = error as { code?: unknown; errno?: unknown; message?: unknown };
	return value?.code === "EDQUOT"
		|| value?.code === "ENOSPC"
		|| value?.errno === -122
		|| value?.errno === 122
		|| (typeof value?.message === "string" && value.message.includes("Unknown system error -122"));
}

export async function withDiskPressureContainment<T>(operation: () => Promise<T>): Promise<T | undefined> {
	try {
		return await operation();
	} catch (error) {
		if (isDiskPressureError(error)) return undefined;
		throw error;
	}
}

export function createRecoveringQueue(): { run<T>(operation: () => Promise<T>): Promise<T | undefined> } {
	let tail: Promise<void> = Promise.resolve();
	return {
		run<T>(operation: () => Promise<T>): Promise<T | undefined> {
			const result = tail.then(() => withDiskPressureContainment(operation));
			tail = result.then(() => undefined, () => undefined);
			return result;
		},
	};
}

interface RollingEventWriterOptions {
	segmentBytes?: number;
	segmentCount?: number;
}

function archivePath(jobDir: string, index: number): string {
	return path.join(jobDir, `stdout.${index}.jsonl`);
}

async function fileSizeOrZero(filePath: string): Promise<number> {
	try {
		return (await fs.promises.stat(filePath)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

export function createRollingEventWriter(jobDir: string, options: RollingEventWriterOptions = {}) {
	const segmentBytes = options.segmentBytes ?? DEFAULT_STDOUT_SEGMENT_BYTES;
	const segmentCount = options.segmentCount ?? DEFAULT_STDOUT_SEGMENT_COUNT;
	const currentPath = path.join(jobDir, "stdout.jsonl");
	const queue = createRecoveringQueue();

	function existingArchivePaths(): string[] {
		const archives: string[] = [];
		for (let index = 1; index < segmentCount; index++) {
			const candidate = archivePath(jobDir, index);
			if (fs.existsSync(candidate)) archives.push(candidate);
		}
		return archives;
	}

	function segmentPaths(): string[] {
		return [...existingArchivePaths(), ...(fs.existsSync(currentPath) ? [currentPath] : [])];
	}

	async function rotate(): Promise<void> {
		let archiveCount = existingArchivePaths().length;
		if (archiveCount >= segmentCount - 1) {
			await fs.promises.rm(archivePath(jobDir, 1), { force: true });
			for (let index = 2; index <= archiveCount; index++) {
				const from = archivePath(jobDir, index);
				if (fs.existsSync(from)) await fs.promises.rename(from, archivePath(jobDir, index - 1));
			}
			archiveCount--;
		}
		if (fs.existsSync(currentPath)) {
			await fs.promises.rename(currentPath, archivePath(jobDir, archiveCount + 1));
		}
	}

	return {
		appendLine(line: string): Promise<void | undefined> {
			return queue.run(async () => {
				let event: { type?: unknown };
				try {
					event = JSON.parse(line) as { type?: unknown };
				} catch {
					return;
				}
				if (event.type === "message_update") return;

				const record = Buffer.from(`${line}\n`, "utf8");
				if (record.byteLength > segmentBytes) return;

				await ensurePrivateDirectory(jobDir);
				if ((await fileSizeOrZero(currentPath)) + record.byteLength > segmentBytes) await rotate();
				await fs.promises.appendFile(currentPath, record, { mode: 0o600 });
				await ensurePrivateFile(currentPath);
			});
		},
		segmentPaths,
	};
}

async function measureRoot(root: string): Promise<number> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}

	let total = 0;
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) total += await measureRoot(entryPath);
		else if (entry.isFile()) total += (await fs.promises.lstat(entryPath)).size;
	}
	return total;
}

export async function measureArtifactUsage(roots: ArtifactRoots): Promise<number> {
	return (await measureRoot(roots.subagentsDir)) + (await measureRoot(roots.chainsDir));
}

function formatUsage(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function createArtifactUsageWarningCoordinator(options: {
	measure: () => Promise<number>;
	notify: (message: string) => void;
	warn?: (message: string) => void;
	now?: () => number;
	scanIntervalMs?: number;
	warningCooldownMs?: number;
	threshold?: number;
	manualCleanupPath?: string;
}) {
	const now = options.now ?? Date.now;
	const scanIntervalMs = options.scanIntervalMs ?? 60 * 60 * 1000;
	const warningCooldownMs = options.warningCooldownMs ?? 24 * 60 * 60 * 1000;
	const threshold = options.threshold ?? DEFAULT_ARTIFACT_USAGE_WARNING_BYTES;
	const manualCleanupPath = options.manualCleanupPath ?? "~/.local/state/pi-background-subagents";
	let lastScan = -Infinity;
	let lastWarning = -Infinity;
	let inFlight: Promise<void> | undefined;

	async function check(): Promise<void> {
		if (inFlight) return inFlight;
		if (now() - lastScan < scanIntervalMs) return;
		lastScan = now();
		inFlight = (async () => {
			try {
				const usage = await options.measure();
				if (usage <= threshold || now() - lastWarning < warningCooldownMs) return;
				const message = `Background subagent artifacts use ${formatUsage(usage)}. Clean up manually at ${manualCleanupPath}.`;
				try {
					options.notify(message);
				} catch {
					options.warn?.(message);
				}
				lastWarning = now();
			} catch {
				// Usage warnings must not affect Pi.
			} finally {
				inFlight = undefined;
			}
		})();
		return inFlight;
	}

	return { check };
}
