import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_ROOT_PLACEHOLDER as PH } from "../src/hooks-file.js";
import { HooksPlugin, type HooksPluginOptions } from "../src/index.js";

type Recorded = { command: string; env: Record<string, string> };

/** Builds a fake opencode plugin input whose shell records commands instead of running them. */
function harness(replies: (command: string) => { stdout?: string; exitCode?: number } = () => ({})) {
  const executed: Recorded[] = [];
  const logs: Array<Record<string, unknown>> = [];

  // biome-ignore lint/suspicious/noExplicitAny: a deliberately loose stand-in for BunShell.
  const $: any = (_strings: TemplateStringsArray, ...expressions: any[]) => {
    const command = String(expressions[0] ?? "");
    let env: Record<string, string> = {};
    const reply = replies(command);
    const result = {
      stdout: Buffer.from(reply.stdout ?? ""),
      stderr: Buffer.from(""),
      exitCode: reply.exitCode ?? 0,
    };
    // biome-ignore lint/suspicious/noExplicitAny: mirrors BunShellPromise's fluent chain.
    const chain: any = Promise.resolve(result).then((value) => {
      executed.push({ command, env });
      return value;
    });
    chain.cwd = () => chain;
    chain.env = (next: Record<string, string>) => {
      env = next;
      return chain;
    };
    chain.quiet = () => chain;
    chain.nothrow = () => chain;
    return chain;
  };

  const client = {
    app: {
      log: async (payload: { body: Record<string, unknown> }) => {
        logs.push(payload.body);
      },
    },
  };

  return { $, client, executed, logs };
}

async function hooksDir(file: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "plugin-test-"));
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

/** Loads the plugin and returns the hooks it registered plus the harness spies. */
async function load(root: string, options: HooksPluginOptions = {}, replies?: Parameters<typeof harness>[0]) {
  const spies = harness(replies);
  // biome-ignore lint/suspicious/noExplicitAny: PluginInput is wider than the test needs.
  const hooks = await HooksPlugin({ ...spies, directory: root } as any, { root, ...options });
  return { hooks, ...spies };
}

/** Drives `experimental.chat.system.transform` and returns the resulting system blocks. */
async function transform(hooks: Awaited<ReturnType<typeof load>>["hooks"]): Promise<string[]> {
  const output = { system: [] as string[] };
  // biome-ignore lint/suspicious/noExplicitAny: only `model` is required by the signature.
  await hooks["experimental.chat.system.transform"]?.({ model: {} } as any, output);
  return output.system;
}

describe("HooksPlugin", () => {
  let root: string;

  beforeEach(async () => {
    root = await hooksDir(twoCommands);
  });

  test("runs every bridged command in order", async () => {
    const { hooks, executed } = await load(root);
    await transform(hooks);
    expect(executed.map((entry) => entry.command)).toEqual([`"${root}/a.sh"`, `"${root}/b.sh"`]);
  });

  test("exports CLAUDE_PLUGIN_ROOT to the commands", async () => {
    const { hooks, executed } = await load(root);
    await transform(hooks);
    expect(executed[0]?.env.CLAUDE_PLUGIN_ROOT).toBe(root);
  });

  test("never sets CLAUDE_CODE_ENTRYPOINT", async () => {
    const { hooks, executed } = await load(root);
    await transform(hooks);
    expect(executed[0]?.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  test("merges extra env options", async () => {
    const { hooks, executed } = await load(root, { env: { EXTRA: "yes" } });
    await transform(hooks);
    expect(executed[0]?.env.EXTRA).toBe("yes");
  });

  test("honours the skip list", async () => {
    const { hooks, executed } = await load(root, { skip: ["a.sh"] });
    await transform(hooks);
    expect(executed.map((entry) => entry.command)).toEqual([`"${root}/b.sh"`]);
  });

  test("injects collected systemMessages as one system block", async () => {
    const { hooks } = await load(root, {}, (command) => ({
      stdout: `noise\n{ "continue": true, "systemMessage": "from ${command.includes("a.sh") ? "a" : "b"}" }`,
    }));
    expect(await transform(hooks)).toEqual(["## SessionStart hooks\nfrom a\nfrom b"]);
  });

  test("injects nothing when no command emits a systemMessage", async () => {
    const { hooks } = await load(root);
    expect(await transform(hooks)).toEqual([]);
  });

  test("is idempotent across model calls and does not re-run commands", async () => {
    const { hooks, executed } = await load(root, {}, () => ({ stdout: '{ "systemMessage": "once" }' }));
    const first = await transform(hooks);
    const second = await transform(hooks);
    expect(second).toEqual(first);
    expect(executed).toHaveLength(2);
  });

  test("stops at continue:false", async () => {
    const { hooks, executed } = await load(root, {}, (command) =>
      command.includes("a.sh") ? { stdout: '{ "continue": false }' } : {},
    );
    await transform(hooks);
    expect(executed.map((entry) => entry.command)).toEqual([`"${root}/a.sh"`]);
  });

  test("keeps going when a command exits non-zero", async () => {
    const { hooks, executed, logs } = await load(root, {}, (command) =>
      command.includes("a.sh") ? { exitCode: 1 } : {},
    );
    await transform(hooks);
    expect(executed).toHaveLength(2);
    expect(logs.some((entry) => entry.level === "warn")).toBe(true);
  });

  test("registers no hooks when the hooks file is missing", async () => {
    const empty = await mkdtemp(join(tmpdir(), "plugin-test-empty-"));
    const { hooks } = await load(empty);
    expect(hooks).toEqual({});
  });

  test("registers no hooks when the hooks file is malformed", async () => {
    const bad = await mkdtemp(join(tmpdir(), "plugin-test-bad-"));
    await mkdir(join(bad, "hooks"), { recursive: true });
    await writeFile(join(bad, "hooks", "hooks.json"), "{ not json");
    const { hooks, logs } = await load(bad);
    expect(hooks).toEqual({});
    expect(logs.some((entry) => entry.level === "warn")).toBe(true);
  });

  test("registers no hooks when SessionStart is absent", async () => {
    const other = await hooksDir({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }] } });
    const { hooks } = await load(other);
    expect(hooks).toEqual({});
  });

  test("still runs commands when injectSystemMessages is off", async () => {
    const { hooks, executed } = await load(root, { injectSystemMessages: false });
    expect(hooks).toEqual({});
    await Bun.sleep(10);
    expect(executed).toHaveLength(2);
  });

  test("reads .claude/settings.json when no plugin hooks file exists", async () => {
    const settingsRoot = await mkdtemp(join(tmpdir(), "plugin-test-settings-"));
    await mkdir(join(settingsRoot, ".claude"), { recursive: true });
    await writeFile(join(settingsRoot, ".claude", "settings.json"), JSON.stringify(twoCommands));
    const { hooks, executed } = await load(settingsRoot);
    await transform(hooks);
    expect(executed).toHaveLength(2);
  });
});
