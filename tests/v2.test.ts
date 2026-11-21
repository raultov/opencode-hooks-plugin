import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, Exec } from "../src/bridge.js";
import { PLUGIN_ROOT_PLACEHOLDER as PH } from "../src/hooks-file.js";
import { canFailToolCalls, createHooksPluginV2, type HooksPluginV2Dependencies, withContext } from "../src/v2.js";

type Recorded = { command: string; env: Record<string, string>; stdin?: string };
type ToolHandler = (event: Record<string, unknown>) => Promise<void> | void;
type HookHandler = (event: { system: Array<{ type: "text"; text: string }> }) => Promise<void> | void;

/** A minimal opencode V2 context: options, location, and a hook recorder. */
function harness(
  root: string,
  replies: (command: string) => Partial<CommandResult> & { hang?: boolean } = () => ({}),
  options: Record<string, unknown> = {},
  dependencies: Omit<HooksPluginV2Dependencies, "exec"> = {},
  app?: { name: string; version: string; channel: string },
) {
  const executed: Recorded[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const hooks = new Map<string, HookHandler>();
  const toolHooks = new Map<string, ToolHandler>();

  const exec: Exec = (command, commandOptions) => {
    executed.push({ command, env: commandOptions.env, stdin: commandOptions.stdin });
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
    ...(app === undefined ? {} : { app }),
    options,
    location: { directory: root },
    session: {
      hook: async (name: string, callback: HookHandler) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      },
    },
    tool: {
      hook: async (name: string, callback: ToolHandler) => {
        toolHooks.set(name, callback);
        return { dispose: async () => {} };
      },
    },
  };

  return { ctx, dependencies: { exec, log, ...dependencies }, executed, logs, hooks, toolHooks };
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
async function load(
  root: string,
  options: Record<string, unknown> = {},
  replies?: Parameters<typeof harness>[1],
  app?: Parameters<typeof harness>[4],
) {
  const spies = harness(root, replies, options, {}, app);
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
    expect(executed[0]?.env.CLAUDE_PROJECT_DIR).toBe(root);
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
    const other = await hooksDir({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } });
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

describe("HooksPluginV2 PostToolUse", () => {
  const recorder = {
    hooks: {
      PostToolUse: [{ matcher: "Write|Edit|Bash", hooks: [{ type: "command", command: `"${PH}/record.sh"` }] }],
    },
  };

  // The events below are the shapes opencode 2.0.26 hands `execute.after`,
  // captured from a live session: V2 names the tools `write`, `edit`, `shell`
  // and `patch`, and the file argument `path`.

  test("runs the matching command after a completed call", async () => {
    const root = await hooksDir(recorder);
    const { toolHooks, hooks, executed } = await load(root);
    expect([...hooks.keys()]).toEqual(["model.request"]);
    // biome-ignore lint/suspicious/noExplicitAny: the request hook is typed for the system prompt.
    const primary = { sessionID: "ses_1", kind: "primary", model: { id: "claude-opus-5-5" } } as any;
    await hooks.get("model.request")?.(primary);
    await toolHooks.get("execute.after")?.({
      tool: "write",
      sessionID: "ses_1",
      input: { path: "/abs/a.ts", content: "alpha" },
      status: "completed",
    });
    expect(executed.map((entry) => entry.command)).toEqual([`"${root}/record.sh"`]);
    expect(JSON.parse(executed[0]?.stdin ?? "")).toMatchObject({
      hook_event_name: "PostToolUse",
      model: "claude-opus-5-5",
      tool_name: "Write",
      tool_input: { file_path: "/abs/a.ts", content: "alpha" },
    });
  });

  test("keeps the model of the session's own turns only", async () => {
    const root = await hooksDir(recorder);
    const { toolHooks, hooks, executed } = await load(root);
    const request = (kind: string, id: string) =>
      // biome-ignore lint/suspicious/noExplicitAny: the request hook is typed for the system prompt.
      hooks.get("model.request")?.({ sessionID: "ses_1", kind, model: { id } } as any);
    await request("primary", "claude-opus-5-5");
    await request("title", "claude-haiku-5-5");
    await request("compaction", "claude-haiku-5-5");
    await request("generate", "claude-haiku-5-5");
    await toolHooks.get("execute.after")?.({
      tool: "write",
      sessionID: "ses_1",
      input: { path: "/abs/a.ts", content: "alpha" },
      status: "completed",
    });
    expect(JSON.parse(executed[0]?.stdin ?? "").model).toBe("claude-opus-5-5");
  });

  test("maps a V2 edit", async () => {
    const root = await hooksDir(recorder);
    const { toolHooks, executed } = await load(root);
    await toolHooks.get("execute.after")?.({
      tool: "edit",
      sessionID: "ses_1",
      input: { path: "notes.txt", oldString: "alpha", newString: "beta" },
      status: "completed",
    });
    expect(JSON.parse(executed[0]?.stdin ?? "")).toMatchObject({
      tool_name: "Edit",
      tool_input: { file_path: join(root, "notes.txt"), old_string: "alpha", new_string: "beta" },
    });
  });

  test("maps the V2 shell tool to Bash", async () => {
    const root = await hooksDir(recorder);
    const { toolHooks, executed } = await load(root);
    await toolHooks.get("execute.after")?.({
      tool: "shell",
      sessionID: "ses_1",
      input: { command: "ls" },
      status: "completed",
    });
    expect(JSON.parse(executed[0]?.stdin ?? "")).toMatchObject({ tool_name: "Bash", tool_input: { command: "ls" } });
  });

  test("maps the V2 patch tool to one Edit per file", async () => {
    const root = await hooksDir(recorder);
    const { toolHooks, executed } = await load(root);
    await toolHooks.get("execute.after")?.({
      tool: "patch",
      sessionID: "ses_1",
      input: { patchText: "*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch" },
      status: "completed",
    });
    expect(JSON.parse(executed[0]?.stdin ?? "")).toMatchObject({
      tool_name: "Edit",
      tool_input: { file_path: join(root, "a.ts") },
    });
  });

  test("skips a call that failed", async () => {
    const { toolHooks, executed } = await load(await hooksDir(recorder));
    await toolHooks.get("execute.after")?.({ tool: "bash", sessionID: "s", input: { command: "x" }, status: "error" });
    expect(executed).toHaveLength(0);
  });

  test("registers no tool hook when PostToolUse is absent", async () => {
    const { toolHooks } = await load(await hooksDir(twoCommands));
    expect(toolHooks.size).toBe(0);
  });
});

describe("HooksPluginV2 PreToolUse", () => {
  const photographer = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `"${PH}/photo.sh"` }] }],
    },
  };

  test("runs the matching command before the call, with workdir as a cd", async () => {
    const root = await hooksDir(photographer);
    const { toolHooks, hooks, executed } = await load(root);
    expect([...toolHooks.keys()]).toEqual(["execute.before"]);
    expect([...hooks.keys()]).toEqual(["model.request"]);
    await toolHooks.get("execute.before")?.({
      tool: "shell",
      sessionID: "ses_1",
      input: { command: "git commit -m x", workdir: "/other/repo" },
    });
    expect(executed.map((entry) => entry.command)).toEqual([`"${root}/photo.sh"`]);
    expect(JSON.parse(executed[0]?.stdin ?? "")).toMatchObject({
      session_id: "ses_1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cd '/other/repo' && git commit -m x" },
    });
  });

  test("runs nothing before a tool the matcher does not select", async () => {
    const { toolHooks, executed } = await load(await hooksDir(photographer));
    await toolHooks.get("execute.before")?.({ tool: "write", sessionID: "s", input: { path: "/a", content: "" } });
    expect(executed).toHaveLength(0);
  });
});

describe("HooksPluginV2 PreToolUse decisions (preToolDecisions)", () => {
  const guard = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `"${PH}/guard.sh"` }] }],
    },
  };
  const decisions = { preToolDecisions: true };
  const deny = JSON.stringify({
    hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "not here" },
  });

  const shellCall = (input: Record<string, unknown>) => ({ tool: "shell", sessionID: "ses_1", id: "call_1", input });

  test("rejects a denied call, which fails it on opencode 2.0.29 and newer", async () => {
    const app = { name: "opencode", version: "2.3.2", channel: "latest" };
    const { toolHooks } = await load(await hooksDir(guard), decisions, () => ({ stdout: deny }), app);
    await expect(toolHooks.get("execute.before")?.(shellCall({ command: "rm x" }))).rejects.toThrow(
      "Blocked by PreToolUse hook guard.sh: not here",
    );
  });

  test("lets a denied call go ahead on an opencode too old to fail it, and says so", async () => {
    const app = { name: "opencode", version: "2.0.26", channel: "latest" };
    const { toolHooks, logs } = await load(await hooksDir(guard), decisions, () => ({ stdout: deny }), app);
    expect(logs.some((entry) => String(entry.message).includes("opencode 2.0.26 cannot fail a call"))).toBe(true);
    const event = shellCall({ command: "rm x" });
    await toolHooks.get("execute.before")?.(event);
    expect(event.input).toEqual({ command: "rm x" });
  });

  test("never rejects without preToolDecisions, as before", async () => {
    const { toolHooks } = await load(await hooksDir(guard), {}, () => ({ exitCode: 2, stdout: deny }));
    await toolHooks.get("execute.before")?.(shellCall({ command: "rm x" }));
    expect(toolHooks.has("execute.after")).toBe(false);
  });

  test("replaces the input with the rewritten arguments", async () => {
    const update = JSON.stringify({
      hookSpecificOutput: { updatedInput: { command: "ls -la", run_in_background: true } },
    });
    const { toolHooks } = await load(await hooksDir(guard), decisions, () => ({ stdout: update }));
    const event = shellCall({ command: "ls" });
    await toolHooks.get("execute.before")?.(event);
    expect(event.input).toEqual({ command: "ls -la", background: true });
  });

  test("adds additionalContext to the completed call's result", async () => {
    const note = JSON.stringify({ hookSpecificOutput: { additionalContext: "prefer pnpm" } });
    const { toolHooks } = await load(await hooksDir(guard), decisions, () => ({ stdout: note }));
    await toolHooks.get("execute.before")?.(shellCall({ command: "npm i" }));
    const after = { ...shellCall({ command: "npm i" }), status: "completed", result: { content: "done" } };
    await toolHooks.get("execute.after")?.(after);
    expect(after.result).toEqual({ content: "done\n\n[PreToolUse hook context]\nprefer pnpm" });
  });

  test("drops the context of a call that failed", async () => {
    const note = JSON.stringify({ hookSpecificOutput: { additionalContext: "prefer pnpm" } });
    const { toolHooks } = await load(await hooksDir(guard), decisions, () => ({ stdout: note }));
    await toolHooks.get("execute.before")?.(shellCall({ command: "npm i" }));
    await toolHooks.get("execute.after")?.({ ...shellCall({}), status: "error" });
    const after = { ...shellCall({}), status: "completed", result: { content: "later" } };
    await toolHooks.get("execute.after")?.(after);
    expect(after.result).toEqual({ content: "later" });
  });
});

describe("canFailToolCalls", () => {
  test("is true from 2.0.29 on", () => {
    expect(canFailToolCalls("2.0.29")).toBe(true);
    expect(canFailToolCalls("2.1.0")).toBe(true);
    expect(canFailToolCalls("2.3.2")).toBe(true);
    expect(canFailToolCalls("3.0.0")).toBe(true);
  });

  test("is false before 2.0.29", () => {
    expect(canFailToolCalls("2.0.28")).toBe(false);
    expect(canFailToolCalls("2.0.26")).toBe(false);
    expect(canFailToolCalls("1.19.5")).toBe(false);
  });

  test("takes dev, local and unknown builds to be current", () => {
    expect(canFailToolCalls("0.0.0-dev-1330")).toBe(true);
    expect(canFailToolCalls("local")).toBe(true);
    expect(canFailToolCalls(undefined)).toBe(true);
  });
});

describe("withContext", () => {
  test("appends to text content, or adds a text part", () => {
    expect(withContext({ content: "out" }, "note")).toEqual({ content: "out\n\n[PreToolUse hook context]\nnote" });
    expect(withContext({ content: [{ type: "text", text: "out" }] }, "note")).toEqual({
      content: [
        { type: "text", text: "out" },
        { type: "text", text: "[PreToolUse hook context]\nnote" },
      ],
    });
  });

  test("leaves a result with no content as it was", () => {
    expect(withContext({ metadata: { a: 1 } }, "note")).toEqual({ metadata: { a: 1 } });
  });
});
