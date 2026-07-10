import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface ChainControllerLockOwner {
	pid: number;
	runtimeId: string;
	processStartTime?: string;
	acquiredAt: number;
	updatedAt: number;
}

const lockDirectoryName = ".controller-lock";
const ownerFileName = "owner.json";

function getProcessStartTime(pid: number): string | undefined {
	if (process.platform !== "linux") return undefined;

	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		if (commandEnd === -1) return undefined;
		const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
		const startTime = fields[19];
		return /^\d+$/.test(startTime ?? "") ? startTime : undefined;
	} catch {
		return undefined;
	}
}

function isProcessAlive(owner: ChainControllerLockOwner): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
	}

	if (owner.processStartTime === undefined) return true;
	const currentStartTime = getProcessStartTime(owner.pid);
	return currentStartTime === undefined || currentStartTime === owner.processStartTime;
}

function readOwner(lockDir: string): ChainControllerLockOwner | undefined {
	try {
		const owner = JSON.parse(readFileSync(join(lockDir, ownerFileName), "utf8")) as Partial<ChainControllerLockOwner>;
		if (!Number.isInteger(owner.pid) || (owner.pid ?? 0) <= 0) return undefined;
		if (typeof owner.runtimeId !== "string") return undefined;
		if (owner.processStartTime !== undefined && typeof owner.processStartTime !== "string") return undefined;
		if (typeof owner.acquiredAt !== "number" || typeof owner.updatedAt !== "number") return undefined;
		return owner as ChainControllerLockOwner;
	} catch {
		return undefined;
	}
}

export function releaseChainControllerLock(
	chainDir: string,
	ownerIdentity: { runtimeId: string; pid: number },
): void {
	const lockDir = join(chainDir, lockDirectoryName);
	const persistedOwner = readOwner(lockDir);
	if (persistedOwner?.pid !== ownerIdentity.pid || persistedOwner.runtimeId !== ownerIdentity.runtimeId) return;

	const quarantineDir = join(chainDir, `${lockDirectoryName}.release-${randomUUID()}`);
	try {
		renameSync(lockDir, quarantineDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	rmSync(quarantineDir, { recursive: true, force: true });
}

export function tryAcquireChainControllerLock(
	chainDir: string,
	owner: { runtimeId: string; pid: number },
): boolean {
	const lockDir = join(chainDir, lockDirectoryName);

	for (;;) {
		const candidateDir = join(chainDir, `${lockDirectoryName}.candidate-${randomUUID()}`);
		mkdirSync(candidateDir);
		try {
			const now = Date.now();
			writeFileSync(join(candidateDir, ownerFileName), JSON.stringify({
				...owner,
				processStartTime: getProcessStartTime(owner.pid),
				acquiredAt: now,
				updatedAt: now,
			} satisfies ChainControllerLockOwner));
		} catch (error) {
			rmSync(candidateDir, { recursive: true, force: true });
			throw error;
		}

		try {
			renameSync(candidateDir, lockDir);
			return true;
		} catch (error) {
			rmSync(candidateDir, { recursive: true, force: true });
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
		}

		const existingOwner = readOwner(lockDir);
		if (existingOwner && isProcessAlive(existingOwner)) return false;

		const quarantineDir = join(chainDir, `${lockDirectoryName}.quarantine-${randomUUID()}`);
		try {
			renameSync(lockDir, quarantineDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		rmSync(quarantineDir, { recursive: true, force: true });
	}
}
