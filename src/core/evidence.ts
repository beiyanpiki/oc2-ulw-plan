import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UlwError } from "./errors.js";
import { atomicWriteFile, ensureArtifactDir } from "../io/paths.js";
import type { CheckEvidence, CommandCheck } from "./types.js";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export interface ProcessInput {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export function runProcess(input: ProcessInput): Promise<ProcessResult> {
  const started = Date.now();
  const maxBytes = input.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    if (input.argv.length === 0) {
      reject(new UlwError("CHECK_ARGV", "command argv is empty"));
      return;
    }
    if (input.signal?.aborted === true) {
      resolve({ exitCode: null, signal: "SIGTERM", timedOut: false, cancelled: true, stdout: "", stderr: "", truncated: false, durationMs: 0 });
      return;
    }
    const child = spawn(input.argv[0] as string, input.argv.slice(1), {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    let captured = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process already exited.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 1500).unref();
    }, input.timeoutMs);
    timer.unref();
    const onAbort = () => {
      cancelled = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 1500).unref();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      const room = maxBytes - captured;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const slice = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      if (slice.byteLength < chunk.byteLength) truncated = true;
      chunks[target].push(Buffer.from(slice));
      captured += slice.byteLength;
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        signal,
        timedOut,
        cancelled,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        truncated,
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      reject(new UlwError("CHECK_SPAWN", `cannot start ${input.argv[0]}: ${error.message}`));
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export function evaluateExpectation(check: CommandCheck, result: ProcessResult): { passed: boolean; reason: string } {
  if (result.timedOut) return { passed: false, reason: "timed out" };
  if (result.cancelled) return { passed: false, reason: "cancelled" };
  if (result.exitCode !== check.expect.exitCode) {
    return { passed: false, reason: `exit code ${String(result.exitCode)} != ${check.expect.exitCode}` };
  }
  for (const needle of check.expect.stdoutIncludes) {
    if (!result.stdout.includes(needle)) return { passed: false, reason: `stdout is missing ${JSON.stringify(needle)}` };
  }
  for (const needle of check.expect.stderrIncludes) {
    if (!result.stderr.includes(needle)) return { passed: false, reason: `stderr is missing ${JSON.stringify(needle)}` };
  }
  if (result.truncated) return { passed: false, reason: "output exceeded the evidence limit" };
  return { passed: true, reason: "expectation satisfied" };
}

export interface PersistEvidenceInput {
  workspace: string;
  runId: string;
  taskId: string;
  check: CommandCheck;
  attempt: number;
  codeFingerprint: string;
  result: ProcessResult;
  passed: boolean;
  reason: string;
}

export async function persistCommandEvidence(input: PersistEvidenceInput): Promise<CheckEvidence> {
  const dir = await ensureArtifactDir(input.workspace, "evidence", input.runId);
  const stem = `${input.taskId}-${input.check.id}-${input.attempt}`.replaceAll(/[^A-Za-z0-9_.-]/g, "_");
  const stdoutPath = join(dir, `${stem}.stdout.log`);
  const stderrPath = join(dir, `${stem}.stderr.log`);
  const evidencePath = join(dir, `${stem}.json`);
  await atomicWriteFile(stdoutPath, input.result.stdout);
  await atomicWriteFile(stderrPath, input.result.stderr);
  const finished = Date.now();
  const evidence: CheckEvidence = {
    schema: "ulw-check-evidence/v1",
    id: stem,
    runId: input.runId,
    taskId: input.taskId,
    checkId: input.check.id,
    attempt: input.attempt,
    kind: "command",
    codeFingerprint: input.codeFingerprint,
    argv: input.check.argv,
    cwd: input.check.cwd,
    ...(input.result.exitCode === null ? {} : { exitCode: input.result.exitCode }),
    ...(input.result.signal === null ? {} : { signal: input.result.signal }),
    timedOut: input.result.timedOut,
    cancelled: input.result.cancelled,
    passed: input.passed && !input.result.truncated && !input.result.timedOut && !input.result.cancelled,
    outputPath: stdoutPath,
    outputTruncated: input.result.truncated,
    summary: input.reason,
    startedAt: finished - input.result.durationMs,
    finishedAt: finished,
  };
  await atomicWriteFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

export async function readEvidence(path: string): Promise<string> {
  return (await readFile(path, "utf8")).slice(0, 8192);
}

export function openLog(path: string): number {
  return openSync(path, "a", 0o600);
}

export function closeLog(fd: number): void {
  closeSync(fd);
}
