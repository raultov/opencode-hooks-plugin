import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_ROOT_PLACEHOLDER as PH } from "../src/hooks-file.js";
import { HooksPlugin, type HooksPluginOptions } from "../src/index.js";

type Recorded = { command: string; env: Record<string, string>; stdin?: string };

/** Builds a fake opencode plugin input whose shell records commands instead of running them. */
function harness(
  replies: (command: string) => { stdout?: string; stderr?: string; exitCode?: number; hang?: boolean } = () => ({}),
) {
  const executed: Recorded[] = [];
  const logs: Array<Record<string, unknown>> = [];
  /** The literal shell lines, interpolations left as-is, to assert on redirections. */
  const shellLines: string[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: a deliberately loose stand-in for BunShell.
  const $: any = (strings: TemplateStringsArray, ...expressions: any[]) => {
    shellLines.push(strings.join("…"));
    const command = String(expressions[0] ?? "");
    // The second interpolation, when there is one, is the stdin redirection.
    const stdin = expressions[1] === undefined ? undefined : String(expressions[1]);
    let env: Record<string, string> = {};
    const reply = replies(command);
    const result = {
      stdout: Buffer.from(reply.stdout ?? ""),
      stderr: Buffer.from(reply.stderr ?? ""),
      exitCode: reply.exitCode ?? 0,
    };
    // Recorded on the next microtask, once the fluent chain has set its options
    // but before anything can await it, so a `hang` command is still observed
    // as started even though it never resolves.
    queueMicrotask(() => executed.push({ command, env, stdin }));
    // biome-ignore lint/suspicious/noExplicitAny: mirrors BunShellPromise's fluent chain.
    const chain: any = reply.hang ? new Promise(() => {}) : Promise.resolve(result);
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

  return { $, client, executed, logs, shellLines };
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

const threeCommands = {
  hooks: {
    SessionStart: [
      {
        matcher: "startup",
        hooks: [
          { type: "command", command: `"${PH}/a.sh"` },
          { type: "command", command: `"${PH}/slow.sh"` },
          { type: "command", command: `"${PH}/c.sh"` },
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
async function transform(
  hooks: Awaited<ReturnType<typeof load>>["hooks"],
  output: { system: string[] } = { system: [] },
): Promise<string[]> {
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

  test("exports CLAUDE_PROJECT_DIR as the project directory, not the plugin root", async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), "plugin-test-root-"));
    const spies = harness();
    // biome-ignore lint/suspicious/noExplicitAny: PluginInput is wider than the test needs.
    const hooks = await HooksPlugin({ ...spies, directory: root } as any, {
      root: pluginRoot,
      hooksFile: join(root, "hooks", "hooks.json"),
    });
    await transform(hooks);
    expect(spies.executed[0]?.env.CLAUDE_PROJECT_DIR).toBe(root);
    expect(spies.executed[0]?.env.CLAUDE_PLUGIN_ROOT).toBe(pluginRoot);
  });

  test("lets the env option override CLAUDE_PROJECT_DIR", async () => {
    const { hooks, executed } = await load(root, { env: { CLAUDE_PROJECT_DIR: "/custom" } });
    await transform(hooks);
    expect(executed[0]?.env.CLAUDE_PROJECT_DIR).toBe("/custom");
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

  test("runs every command when the skip list holds a blank entry", async () => {
    const { hooks, executed, logs } = await load(root, { skip: ["", "  "] });
    await transform(hooks);
    expect(executed.map((entry) => entry.command)).toEqual([`"${root}/a.sh"`, `"${root}/b.sh"`]);
    expect(logs.some((entry) => entry.level === "warn" && String(entry.message).includes("blank skip"))).toBe(true);
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

  test("does not duplicate the block when the same output is reused", async () => {
    const { hooks } = await load(root, {}, () => ({ stdout: '{ "systemMessage": "once" }' }));
    const output = { system: [] as string[] };
    await transform(hooks, output);
    await transform(hooks, output);
    expect(output.system).toEqual(["## SessionStart hooks\nonce\nonce"]);
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

  test("keeps going when a command never returns", async () => {
    const slowRoot = await hooksDir(threeCommands);
    const { hooks, executed, logs } = await load(slowRoot, { commandTimeoutMs: 20 }, (command) => ({
      hang: command.includes("slow.sh"),
    }));
    await transform(hooks);
    expect(executed.map((entry) => entry.command)).toEqual([
      `"${slowRoot}/a.sh"`,
      `"${slowRoot}/slow.sh"`,
      `"${slowRoot}/c.sh"`,
    ]);
    expect(logs.some((entry) => entry.level === "warn" && String(entry.message).includes("20ms budget"))).toBe(true);
  });

  test("feeds the SessionStart payload on stdin", async () => {
    const { hooks, executed, shellLines } = await load(root);
    await transform(hooks);
    expect(shellLines.every((line) => line.includes("< ") && !line.includes("/dev/null"))).toBe(true);
    expect(JSON.parse(executed[0]?.stdin ?? "")).toEqual({
      hook_event_name: "SessionStart",
      source: "startup",
      cwd: root,
    });
  });

  test("tells the model when a command exits non-zero", async () => {
    const { hooks, logs } = await load(root, {}, (command) => (command.includes("a.sh") ? { exitCode: 3 } : {}));
    expect(await transform(hooks)).toEqual([
      "## SessionStart hooks\n⚠️ hook a.sh exited 3 — its context may be missing",
    ]);
    expect(logs.some((entry) => entry.level === "warn")).toBe(true);
  });

  test("tells the model when a command times out", async () => {
    const { hooks } = await load(root, { commandTimeoutMs: 20 }, (command) => ({ hang: command.includes("a.sh") }));
    expect(await transform(hooks)).toEqual([
      "## SessionStart hooks\n⚠️ hook a.sh timed out after 20ms — its context may be missing",
    ]);
  });

  test("never puts stderr in the notice", async () => {
    const { hooks, logs } = await load(root, {}, (command) =>
      command.includes("a.sh") ? { exitCode: 1, stderr: "token=hunter2" } : {},
    );
    expect((await transform(hooks)).join("\n")).not.toContain("hunter2");
    expect(logs.some((entry) => JSON.stringify(entry.extra ?? {}).includes("hunter2"))).toBe(true);
  });

  test("stays silent about failures when reportFailures is off", async () => {
    const { hooks, logs } = await load(root, { reportFailures: false }, (command) =>
      command.includes("a.sh") ? { exitCode: 3 } : {},
    );
    expect(await transform(hooks)).toEqual([]);
    expect(logs.some((entry) => entry.level === "warn")).toBe(true);
  });

  test("labels a quoted path containing spaces whole", async () => {
    const spaced = await hooksDir({
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `"${PH}/my hooks/a.sh" --flag` }] }],
      },
    });
    const { hooks, logs } = await load(spaced, {}, () => ({ exitCode: 1 }));
    await transform(hooks);
    expect(logs.some((entry) => String(entry.message).startsWith("my hooks/a.sh exited"))).toBe(true);
  });

  test("registers no hooks when the hooks file is missing", async () => {
    const empty = await mkdtemp(join(tmpdir(), "plugin-test-empty-"));
    const { hooks } = await load(empty);
    expect(hooks).toEqual({});
  });

  test("warns when an explicitly configured hooks file does not exist", async () => {
    const empty = await mkdtemp(join(tmpdir(), "plugin-test-explicit-"));
    const { hooks, logs } = await load(empty, { hooksFile: join(empty, "nope.json") });
    expect(hooks).toEqual({});
    expect(logs.some((entry) => entry.level === "warn")).toBe(true);
  });

  test("stays at debug when no hooks file is found and none was configured", async () => {
    const empty = await mkdtemp(join(tmpdir(), "plugin-test-probed-"));
    const { logs } = await load(empty);
    expect(logs.some((entry) => entry.level === "warn")).toBe(false);
    expect(logs.some((entry) => entry.level === "debug")).toBe(true);
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

const recorder = {
  hooks: {
    PostToolUse: [
      {
        matcher: "Write|Edit|Bash",
        hooks: [{ type: "command", command: `"${PH}/record.sh"` }],
      },
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: `"${PH}/bash-only.sh"` }],
      },
    ],
  },
};

/** Drives `tool.execute.after` for one opencode tool call. */
async function afterTool(hooks: Awaited<ReturnType<typeof load>>["hooks"], tool: string, args: unknown) {
  await hooks["tool.execute.after"]?.(
    { tool, sessionID: "ses_1", callID: "call_1", args },
    { title: "", output: "", metadata: {} },
  );
}

describe("HooksPlugin PostToolUse", () => {
  let root: string;

  beforeEach(async () => {
    root = await hooksDir(recorder);
  });

  test("registers tool.execute.after even with no SessionStart commands", async () => {
    const { hooks } = await load(root);
    expect(hooks["tool.execute.after"]).toBeDefined();
    expect(hooks["experimental.chat.system.transform"]).toBeUndefined();
  });

  test("registers nothing for tools when PostToolUse is absent", async () => {
    const { hooks } = await load(await hooksDir(twoCommands));
    expect(hooks["tool.execute.after"]).toBeUndefined();
  });

  test("runs the matching commands with a Claude-shaped payload", async () => {
    const { hooks, executed } = await load(root);
    await afterTool(hooks, "edit", { filePath: "src/a.ts", oldString: "x", newString: "y" });
    expect(executed.map((entry) => entry.command)).toEqual([`"${root}/record.sh"`]);
    expect(JSON.parse(executed[0]?.stdin ?? "")).toEqual({
      session_id: "ses_1",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(root, "src/a.ts"), old_string: "x", new_string: "y" },
    });
  });

  test("adds the model the session last called", async () => {
    const { hooks, executed } = await load(root);
    const params = { temperature: 0, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} };
    // biome-ignore lint/suspicious/noExplicitAny: only sessionID and model.id are read.
    await hooks["chat.params"]?.({ sessionID: "ses_1", model: { id: "claude-opus-5-5" } } as any, params);
    await afterTool(hooks, "write", { filePath: "a", content: "" });
    expect(JSON.parse(executed[0]?.stdin ?? "").model).toBe("claude-opus-5-5");
  });

  test("sends no model before any model call", async () => {
    const { hooks, executed } = await load(root);
    await afterTool(hooks, "write", { filePath: "a", content: "" });
    expect(JSON.parse(executed[0]?.stdin ?? "")).not.toHaveProperty("model");
  });

  test("selects commands by matcher", async () => {
    const { hooks, executed } = await load(root);
    await afterTool(hooks, "bash", { command: "sed -i s/a/b/ f" });
    expect(executed.map((entry) => entry.command)).toEqual([`"${root}/record.sh"`, `"${root}/bash-only.sh"`]);
  });

  test("ignores tools with no Claude Code counterpart", async () => {
    const { hooks, executed } = await load(root);
    await afterTool(hooks, "read", { filePath: "a" });
    expect(executed).toHaveLength(0);
  });

  test("runs once per file an apply_patch leaves on disk", async () => {
    const { hooks, executed } = await load(root);
    const patchText =
      "*** Begin Patch\n*** Add File: a.ts\n+x\n*** Delete File: b.ts\n*** Update File: c.ts\n*** Move to: d.ts\n*** End Patch";
    await afterTool(hooks, "apply_patch", { patchText });
    expect(executed.map((entry) => JSON.parse(entry.stdin ?? "").tool_input.file_path)).toEqual([
      join(root, "a.ts"),
      join(root, "d.ts"),
    ]);
  });

  test("runs nothing for an edit with no file path", async () => {
    const { hooks, executed } = await load(root);
    await afterTool(hooks, "edit", { oldString: "x", newString: "y" });
    expect(executed).toHaveLength(0);
  });

  test("exports CLAUDE_PROJECT_DIR as the project directory", async () => {
    const { hooks, executed } = await load(root);
    await afterTool(hooks, "write", { filePath: "a", content: "" });
    expect(executed[0]?.env.CLAUDE_PROJECT_DIR).toBe(root);
  });

  test("logs a failing command without throwing", async () => {
    const { hooks, logs } = await load(root, {}, () => ({ exitCode: 2, stderr: "boom" }));
    await afterTool(hooks, "write", { filePath: "a", content: "" });
    expect(logs.some((entry) => entry.level === "warn" && String(entry.message).includes("exited 2"))).toBe(true);
  });

  test("gives up on a command that never returns", async () => {
    const { hooks, logs } = await load(root, { commandTimeoutMs: 20 }, () => ({ hang: true }));
    await afterTool(hooks, "write", { filePath: "a", content: "" });
    expect(logs.some((entry) => String(entry.message).includes("20ms budget"))).toBe(true);
  });
});
