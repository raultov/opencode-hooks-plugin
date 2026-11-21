import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIO, runCli } from "../src/cli.js";
import { PLUGIN_ROOT_PLACEHOLDER as PH } from "../src/hooks-file.js";
import { fingerprint, readApprovals } from "../src/trust.js";

const hooks = {
  hooks: {
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `"${PH}/boot.sh"` }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
    Stop: [{ hooks: [{ type: "command", command: "not-bridged.sh" }] }],
  },
};

/** A project with a `.claude/settings.json`, and an approvals file beside it. */
async function project() {
  const base = await mkdtemp(join(tmpdir(), "cli-test-"));
  const dir = join(base, "repo");
  await mkdir(join(dir, ".claude"), { recursive: true });
  await writeFile(join(dir, ".claude", "settings.json"), JSON.stringify(hooks));
  return { dir, approvalsFile: join(base, "config", "approved.json") };
}

function io(cwd: string, confirm?: CliIO["confirm"]) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIO = {
    cwd,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    confirm,
  };
  return { io: value, out, err };
}

describe("runCli", () => {
  test("status lists the bridged commands and approves nothing", async () => {
    const { dir, approvalsFile } = await project();
    const { io: cli, out } = io(dir);
    expect(await runCli(["status", "--approvals-file", approvalsFile], cli)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(`NOT APPROVED  SessionStart [startup]\n  "${dir}/boot.sh"`);
    expect(text).toContain("NOT APPROVED  PreToolUse [Bash]\n  guard.sh");
    expect(text).not.toContain("not-bridged.sh");
    expect(text).toContain("2 command(s) not approved.");
    expect((await readApprovals(approvalsFile)).approved).toEqual({});
  });

  test("approve --yes stores the fingerprints the plugin computes", async () => {
    const { dir, approvalsFile } = await project();
    const { io: cli } = io(dir);
    expect(await runCli(["approve", "--yes", "--approvals-file", approvalsFile], cli)).toBe(0);
    const hooksFile = join(dir, ".claude", "settings.json");
    expect(Object.keys((await readApprovals(approvalsFile)).approved).sort()).toEqual(
      [
        fingerprint({ hooksFile, event: "SessionStart", matcher: "startup", command: `"${dir}/boot.sh"` }),
        fingerprint({ hooksFile, event: "PreToolUse", matcher: "Bash", command: "guard.sh" }),
      ].sort(),
    );
  });

  test("approve asks first, and a no approves nothing", async () => {
    const { dir, approvalsFile } = await project();
    const questions: string[] = [];
    const { io: cli } = io(dir, async (question) => {
      questions.push(question);
      return false;
    });
    expect(await runCli(["approve", "--approvals-file", approvalsFile], cli)).toBe(1);
    expect(questions).toHaveLength(1);
    expect((await readApprovals(approvalsFile)).approved).toEqual({});
  });

  test("approve refuses without a terminal to ask on or --yes", async () => {
    const { dir, approvalsFile } = await project();
    const { io: cli, err } = io(dir);
    expect(await runCli(["approve", "--approvals-file", approvalsFile], cli)).toBe(1);
    expect(err.join("\n")).toContain("--yes");
  });

  test("says when every command is already approved", async () => {
    const { dir, approvalsFile } = await project();
    await runCli(["approve", "--yes", "--approvals-file", approvalsFile], io(dir).io);
    const { io: cli, out } = io(dir);
    expect(await runCli(["approve", "--approvals-file", approvalsFile], cli)).toBe(0);
    expect(out.at(-1)).toBe("Every command is approved.");
  });

  test("expands the placeholder to --root exactly as given", async () => {
    const { dir, approvalsFile } = await project();
    const { io: cli, out } = io(dir);
    await runCli(
      ["status", "--root", "/plugin/root", "--hooks-file", ".claude/settings.json", "--approvals-file", approvalsFile],
      cli,
    );
    expect(out.join("\n")).toContain('"/plugin/root/boot.sh"');
  });

  test("prints the usage on a bad command line", async () => {
    const { io: cli, err } = io(tmpdir());
    expect(await runCli([], cli)).toBe(2);
    expect(await runCli(["status", "--root"], cli)).toBe(2);
    expect(await runCli(["status", "--nope"], cli)).toBe(2);
    expect(err.join("\n")).toContain("Usage:");
  });

  test("fails when there is no hooks file", async () => {
    const empty = await mkdtemp(join(tmpdir(), "cli-empty-"));
    const { io: cli, err } = io(empty);
    expect(await runCli(["status", "--approvals-file", join(empty, "a.json")], cli)).toBe(1);
    expect(err.join("\n")).toContain("no hooks file found");
  });
});
