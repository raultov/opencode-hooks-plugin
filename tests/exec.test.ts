import { describe, expect, test } from "bun:test";
import { spawnExec } from "../src/exec.js";

const options = { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } };

/** Whether a process id is still alive. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("spawnExec", () => {
  test("hands the payload on stdin and returns output and exit code", async () => {
    const result = await spawnExec("cat; echo oops >&2; exit 3", { ...options, stdin: "payload" });
    expect(result).toEqual({ stdout: "payload", stderr: "oops\n", exitCode: 3 });
  });

  test("gives a command that reads stdin EOF when there is no payload", async () => {
    expect((await spawnExec("cat", options)).exitCode).toBe(0);
  });

  test("kills the whole process group once the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    // Prints the background child's pid, then waits on it: both must die.
    const running = spawnExec("sleep 30 & echo $!; wait", { ...options, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await running;
    expect(Date.now() - started).toBeLessThan(5_000);
    const child = Number(result.stdout.trim());
    expect(child).toBeGreaterThan(0);
    await Bun.sleep(50);
    expect(alive(child)).toBe(false);
  });

  test("kills at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await spawnExec("sleep 30", { ...options, signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
