import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, Exec } from "../src/bridge.js";
import { PLUGIN_ROOT_PLACEHOLDER as PH } from "../src/hooks-file.js";
import { createHooksPluginV2, type HooksPluginV2Dependencies } from "../src/v2.js";

type Recorded = { command: string; env: Record<string, string> };
type HookHandler = (event: { system: Array<{ type: "text"; text: string }> }) => Promise<void> | void;

/** A minimal opencode V2 context: options, location, and a hook recorder. */
function harness(
  root: string,
  replies: (command: string) => Partial<CommandResult> & { hang?: boolean } = () => ({}),
  options: Record<string, unknown> = {},
  dependencies: Omit<HooksPluginV2Dependencies, "exec"> = {},
) {
  const executed: Recorded[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const hooks = new Map<string, HookHandler>();

  const exec: Exec = (command, commandOptions) => {
    executed.push({ command, env: commandOptions.env });
    const reply = replies(command);
    if (reply.hang) return new Promise<CommandResult>(() => {});
    return Promise.resolve({
      stdout: reply.stdout ?? "",
      stderr: reply.stderr ?? "",
      exitCode: reply.exitCode ?? 0,
    });
  };

  const log = (level: string, message: string, extra?: Record<string, unknown>) => {
    logs.push({ level, message, extra });
  };

  const ctx = {
    options,
    location: { directory: root },
    session: {
      hook: async (name: string, callback: HookHandler) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      },
    },
  };

  return { ctx, dependencies: { exec, log, ...dependencies }, executed, logs, hooks };
}

async function hooksDir(file: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "v2-test-"));
  await mkdir(join(root, "hooks"), { recursive: true });
  await writeFile(join(root, "hooks", "hooks.json"), JSON.stringify(file));
  return root;
}

const twoCommands = {
  hooks: {
    SessionStart: [
      {
        matcher: "startup",
        hooks: [
          { type: "command", command: `"${PH}/a.sh"`, description: "first" },
          { type: "command", command: `"${PH}/b.sh"` },
        ],
      },
    ],
  },
};

/** Loads the plugin against a fake context and returns the harness spies. */
async function load(root: string, options: Record<string, unknown> = {}, replies?: Parameters<typeof harness>[1]) {
  const spies = harness(root, replies, options);
  const plugin = createHooksPluginV2(spies.dependencies);
  // biome-ignore lint/suspicious/noExplicitAny: the fake context is narrower than the SDK's.
  await plugin.setup(spies.ctx as any);
  return spies;
}

/** Drives one registered request hook and returns the resulting system parts. */
async function drive(hooks: Map<string, HookHandler>, kind: string): Promise<string[]> {
  const event = { system: [] as Array<{ type: "text"; text: string }> };
  await hooks.get(kind)?.(event);
  return event.system.map((part) => part.text);
}

describe("HooksPluginV2", () => {
  let root: string;

  beforeEach(async () => {
    root = await hooksDir(twoCommands);
  });

  test("registers every model request kind that carries a system prompt", async () => {
    const { hooks } = await load(root);
    expect([...hooks.keys()].sort()).toEqual(["compaction", "context", "generate", "title"]);
  });

  test("runs every bridged command in order", async () => {
    const { hooks, executed } = await load(root);
    await drive(hooks, "context");
    expect(executed.map((entry) => entry.command)).toEqual([`"${root}/a.sh"`, `"${root}/b.sh"`]);
  });

  test("exports CLAUDE_PLUGIN_ROOT and never CLAUDE_CODE_ENTRYPOINT", async () => {
    const { hooks, executed } = await load(root);
    await drive(hooks, "context");
    expect(executed[0]?.env.CLAUDE_PLUGIN_ROOT).toBe(root);
    expect(executed[0]?.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  test("injects collected systemMessages as one text system part", async () => {
    const { hooks } = await load(root, {}, (command) => ({
      stdout: `noise\n{ "systemMessage": "from ${command.includes("a.sh") ? "a" : "b"}" }`,
    }));
    expect(await drive(hooks, "context")).toEqual(["## SessionStart hooks\nfrom a\nfrom b"]);
  });

  test("is idempotent across model calls and does not re-run commands", async () => {
    const { hooks, executed } = await load(root, {}, () => ({ stdout: '{ "systemMessage": "once" }' }));
    const first = await drive(hooks, "context");
    expect(await drive(hooks, "title")).toEqual(first);
    expect(executed).toHaveLength(2);
  });

  test("does not duplicate the block on a request that already carries it", async () => {
    const { hooks } = await load(root, {}, () => ({ stdout: '{ "systemMessage": "once" }' }));
    const event = { system: [] as Array<{ type: "text"; text: string }> };
    await hooks.get("context")?.(event);
    await hooks.get("context")?.(event);
    expect(event.system).toEqual([{ type: "text", text: "## SessionStart hooks\nonce\nonce" }]);
  });

  test("stops at continue:false", async () => {
    const { hooks, executed } = await load(root, {}, (command) =>
      command.includes("a.sh") ? { stdout: '{ "continue": false }' } : {},
    );
    await drive(hooks, "context");
    expect(executed.map((entry) => entry.command)).toEqual([`"${root}/a.sh"`]);
  });

  test("tells the model when a command fails and never puts stderr in the notice", async () => {
    const { hooks, logs } = await load(root, {}, (command) =>
      command.includes("a.sh") ? { exitCode: 3, stderr: "token=hunter2" } : {},
    );
    expect(await drive(hooks, "context")).toEqual([
      "## SessionStart hooks\n⚠️ hook a.sh exited 3 — its context may be missing",
    ]);
    expect(JSON.stringify(logs)).toContain("hunter2");
  });

  test("tells the model when a command times out", async () => {
    const { hooks } = await load(root, { commandTimeoutMs: 20 }, (command) => ({
      hang: command.includes("a.sh"),
    }));
    expect(await drive(hooks, "context")).toEqual([
      "## SessionStart hooks\n⚠️ hook a.sh timed out after 20ms — its context may be missing",
    ]);
  });

  test("reads options from the context", async () => {
    const { hooks, executed } = await load(root, { skip: ["a.sh"] });
    await drive(hooks, "context");
    expect(executed.map((entry) => entry.command)).toEqual([`"${root}/b.sh"`]);
  });

  test("registers no hooks when no hooks file exists", async () => {
    const empty = await mkdtemp(join(tmpdir(), "v2-test-empty-"));
    const { hooks, logs } = await load(empty);
    expect(hooks.size).toBe(0);
    expect(logs.some((entry) => entry.level === "warn")).toBe(false);
    expect(logs.some((entry) => entry.level === "debug")).toBe(true);
  });

  test("registers no hooks when SessionStart is absent", async () => {
    const other = await hooksDir({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }] } });
    const { hooks } = await load(other);
    expect(hooks.size).toBe(0);
  });

  test("still runs commands when injectSystemMessages is off", async () => {
    const { hooks, executed } = await load(root, { injectSystemMessages: false });
    expect(hooks.size).toBe(0);
    await Bun.sleep(10);
    expect(executed).toHaveLength(2);
  });
});
