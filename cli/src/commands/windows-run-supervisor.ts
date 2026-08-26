import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolvePaperclipInstanceRoot } from "../config/home.js";
import {
  readRuntimeInfo,
  removeRuntimeInfoForPid,
  type PaperclipRuntimeInfo,
} from "../runtime-info.js";
import { buildLocalHealthUrl } from "../utils/health-url.js";

const execFileAsync = promisify(execFile);
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_CHILD_STOP_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_GRACE_MS = 60_000;

export type WindowsRunHealth = {
  listenerOk: boolean;
  databaseBackupOk: boolean;
  databaseBackupStatus: string | null;
};

type SupervisedChild = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | number | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown;
  send?: ChildProcess["send"];
};

type WindowsRunSupervisorOptions = {
  instanceId: string;
  startChild: () => SupervisedChild;
  probeHealth: (childPid: number) => Promise<WindowsRunHealth>;
  stopChild: (child: SupervisedChild) => Promise<void>;
  log: (message: string) => void;
  failureThreshold?: number;
  startupGraceMs?: number;
  now?: () => number;
};

/**
 * Supervises the child that owns a Windows foreground `paperclipai run`.
 *
 * Windows has no supported service manager in the CLI today. Keeping the
 * server in a child lets the foreground command retain a single owner while
 * replacing a node process whose HTTP listener disappeared without exiting.
 */
export class WindowsRunSupervisor {
  private child: SupervisedChild | null = null;
  private failures = 0;
  private stopping = false;
  private restarting: Promise<void> | null = null;
  private restartFromPid: number | null = null;
  private readonly failureThreshold: number;
  private readonly startupGraceMs: number;
  private readonly now: () => number;
  private childStartedAt = 0;
  private childHasBeenHealthy = false;
  private backupWarningLogged = false;
  private tickInFlight: Promise<void> | null = null;

  constructor(private readonly options: WindowsRunSupervisorOptions) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.startupGraceMs = options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
    this.now = options.now ?? Date.now;
  }

  get childPid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    if (this.child) return;
    const child = this.options.startChild();
    if (!child.pid) throw new Error("Paperclip Windows supervisor failed to start a server child.");
    this.child = child;
    this.failures = 0;
    this.childStartedAt = this.now();
    this.childHasBeenHealthy = false;
    const childPid = child.pid;
    child.once("exit", () => {
      if (this.stopping || this.restarting) return;
      void this.restart(`server_child_exit`, childPid);
    });
    this.options.log(`[paperclipai run] Windows supervisor started server child pid=${childPid}.`);
  }

  async tick(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;
    this.tickInFlight = this.tickOnce().finally(() => { this.tickInFlight = null; });
    return this.tickInFlight;
  }

  private async tickOnce(): Promise<void> {
    const child = this.child;
    if (!child?.pid || this.stopping || this.restarting) return;

    const health = await this.options.probeHealth(child.pid);
    if (this.child !== child || this.stopping || this.restarting) return;
    if (health.listenerOk) {
      this.childHasBeenHealthy = true;
      this.failures = 0;
      if (this.restartFromPid !== null) {
        if (health.databaseBackupOk) {
          if (this.restartFromPid === child.pid) {
            this.options.log(
              `[paperclipai run] Windows supervisor observed listener recovery without replacement: pid=${child.pid} health=ok databaseBackup=${health.databaseBackupStatus ?? "disabled"}.`,
            );
          } else {
            this.options.log(
              `[paperclipai run] Windows supervisor restored listener: oldPid=${this.restartFromPid} newPid=${child.pid} health=ok databaseBackup=${health.databaseBackupStatus ?? "disabled"}.`,
            );
          }
          this.restartFromPid = null;
          this.backupWarningLogged = false;
        } else if (!this.backupWarningLogged) {
          this.options.log(
            `[paperclipai run] Windows supervisor restored listener but database backup is not healthy: oldPid=${this.restartFromPid} newPid=${child.pid} databaseBackup=${health.databaseBackupStatus ?? "unknown"}.`,
          );
          this.backupWarningLogged = true;
        }
      }
      return;
    }

    if (!this.childHasBeenHealthy && this.now() - this.childStartedAt < this.startupGraceMs) return;
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      await this.restart("listener_loss", child.pid);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (child) await this.options.stopChild(child);
  }

  private async restart(reason: "listener_loss" | "server_child_exit", oldPid: number): Promise<void> {
    if (this.restarting || this.stopping) return this.restarting ?? undefined;
    this.restarting = (async () => {
      this.options.log(`[paperclipai run] Windows supervisor restarting instance=${this.options.instanceId} reason=${reason} oldPid=${oldPid}.`);
      const previousChild = this.child;
      this.child = null;
      this.failures = 0;
      this.restartFromPid = oldPid;
      this.backupWarningLogged = false;
      if (previousChild && reason === "listener_loss") {
        try {
          await this.options.stopChild(previousChild);
        } catch (error) {
          // Do not launch a second child while the previous process may still
          // own the port. Keep it as the sole owner and retry this restart on
          // the next failed probe instead of leaving the supervisor empty.
          this.child = previousChild;
          this.options.log(
            `[paperclipai run] Windows supervisor could not stop oldPid=${oldPid}; will retry listener recovery without starting another server: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
      }
      removeRuntimeInfoForPid(oldPid, this.options.instanceId);
      this.start();
    })().finally(() => {
      this.restarting = null;
    });
    return this.restarting;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function supervisorLockPath(instanceId: string): string {
  return path.join(resolvePaperclipInstanceRoot(instanceId), "windows-run-supervisor.lock");
}

/** Acquire a per-instance, crash-safe lock for the foreground Windows supervisor. */
export function acquireWindowsRunSupervisorLock(instanceId: string): () => void {
  const lockPath = supervisorLockPath(instanceId);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${randomUUID()}`;

  for (;;) {
    try {
      fs.writeFileSync(lockPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return () => {
        try {
          if (fs.readFileSync(lockPath, "utf8").trim() === token) fs.rmSync(lockPath, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let existing: string;
    try {
      existing = fs.readFileSync(lockPath, "utf8").trim();
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw readError;
    }
    const ownerPid = Number.parseInt(existing.split(":", 1)[0] ?? "", 10);
    if (Number.isInteger(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
      throw new Error(`Paperclip instance '${instanceId}' is already supervised by foreground process ${ownerPid}.`);
    }
    try {
      if (fs.readFileSync(lockPath, "utf8").trim() === existing) fs.rmSync(lockPath, { force: true });
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
    }
  }
}

function runtimeHealthUrl(runtime: PaperclipRuntimeInfo): string {
  return buildLocalHealthUrl(runtime.host, runtime.port);
}

export async function probeRuntimeHealth(instanceId: string, expectedPid: number): Promise<WindowsRunHealth> {
  const runtime = readRuntimeInfo(instanceId);
  if (!runtime || runtime.pid !== expectedPid) return { listenerOk: false, databaseBackupOk: false, databaseBackupStatus: null };
  try {
    const response = await fetch(runtimeHealthUrl(runtime), { signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS) });
    const body = await response.json() as { status?: unknown; databaseBackup?: { enabled?: unknown; status?: unknown } };
    const databaseBackupStatus = typeof body.databaseBackup?.status === "string" ? body.databaseBackup.status : null;
    const databaseBackupOk = body.databaseBackup?.enabled !== true || databaseBackupStatus === "ok";
    return {
      listenerOk: response.ok && body.status === "ok",
      databaseBackupOk,
      databaseBackupStatus,
    };
  } catch {
    return { listenerOk: false, databaseBackupOk: false, databaseBackupStatus: null };
  }
}

async function waitForChildExit(child: SupervisedChild, timeoutMs = DEFAULT_CHILD_STOP_TIMEOUT_MS): Promise<boolean> {
  if (!child.pid) return true;
  if (child.exitCode !== null && child.exitCode !== undefined) return true;
  if (child.signalCode !== null && child.signalCode !== undefined) return true;
  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

export async function stopWindowsServerChild(child: SupervisedChild): Promise<void> {
  if (!child.pid) return;
  const gracefulExit = waitForChildExit(child);
  try {
    if (child.send) child.send({ type: "paperclip:graceful-shutdown" });
    else child.kill("SIGTERM");
  } catch {
    // The child may have exited between the health failure and the restart.
  }
  if (await gracefulExit) return;
  await execFileAsync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"]).catch(() => undefined);
  if (!(await waitForChildExit(child, 5_000))) {
    throw new Error(`Timed out stopping Paperclip server child ${child.pid}.`);
  }
}

function supervisedChildArgs(): string[] {
  const args = process.argv.slice(1);
  if (args.includes("--supervised-child")) return args;
  return [...args, "--supervised-child"];
}

/**
 * Runs the Windows-only parent watchdog until the operator terminates it.
 * The child receives the original CLI argv plus a hidden recursion guard.
 */
export async function runWithWindowsSupervisor(instanceId: string): Promise<void> {
  const releaseLock = acquireWindowsRunSupervisorLock(instanceId);
  const supervisor = new WindowsRunSupervisor({
    instanceId,
    startChild: () => spawn(process.execPath, supervisedChildArgs(), {
      cwd: process.cwd(),
      env: { ...process.env, PAPERCLIP_WINDOWS_RUN_SUPERVISED_CHILD: "1" },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    }),
    probeHealth: (pid) => probeRuntimeHealth(instanceId, pid),
    stopChild: stopWindowsServerChild,
    log: (message) => console.error(message),
  });

  let interval: NodeJS.Timeout | null = null;
  const shutdown = async () => {
    if (interval) clearInterval(interval);
    try {
      await supervisor.stop();
    } finally {
      releaseLock();
    }
  };
  const onSignal = () => { void shutdown().finally(() => process.exit(0)); };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    supervisor.start();
    interval = setInterval(() => { void supervisor.tick(); }, 2_000);
  } catch (error) {
    await shutdown();
    throw error;
  }
}
