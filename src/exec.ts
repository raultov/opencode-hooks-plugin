import { type ChildProcess, spawn } from "node:child_process";
import type { Exec } from "./bridge.js";

/** How long a killed command gets to exit after `SIGTERM` before it gets `SIGKILL`. */
export const KILL_GRACE_MS = 2_000;

/**
 * `node:child_process` execution: `sh -c` with the event payload on stdin,
 * closed straight after, so a hook that reads stdin sees EOF instead of
 * hanging the chain.
 *
 * stdout and stderr are drained as they arrive, so a command abandoned after
 * its budget keeps running without blocking on a full pipe.
 *
 * Without a `signal` the command is never killed, as it always was. With one
 * (the `killOnTimeout` option), the command runs in a process group of its
 * own, and aborting the signal sends that whole group `SIGTERM`, then
 * `SIGKILL` after `KILL_GRACE_MS`, so whatever the shell started goes too.
 */
export const spawnExec: Exec = (command, { cwd, env, stdin, signal }) =>
  new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // A group of its own only when it may be killed: a detached command no
      // longer gets the terminal's signals, which nothing else should change.
      detached: signal !== undefined,
    });
    // A hook that exits without reading its stdin closes the pipe under us.
    // That is its right, not a failure of the command.
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin ?? "");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (signal) {
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const kill = () => {
        terminate(child, "SIGTERM");
        escalation = setTimeout(() => terminate(child, "SIGKILL"), KILL_GRACE_MS);
        escalation.unref();
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
      child.once("close", () => {
        signal.removeEventListener("abort", kill);
        clearTimeout(escalation);
      });
    }

    // A spawn failure resolves rather than rejects: the bridge reports it like
    // any other failed command and moves on.
    child.on("error", (error) => {
      resolve({ stdout, stderr: `${stderr}\n${String(error)}`.trim(), exitCode: 127 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });

/**
 * Signals the command's process group, or the shell alone where groups cannot
 * be signalled (Windows). A group that is already gone is not an error.
 */
function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already exited.
    }
  }
}
