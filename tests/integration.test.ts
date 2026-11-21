import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin/promise/plugin";
import type { PluginInput } from "@opencode-ai/plugin";
import { $ } from "bun";
import type { HooksPluginOptions } from "../src/bridge.js";
import { HooksPlugin } from "../src/v1.js";
import { createHooksPluginV2 } from "../src/v2.js";

/**
 * End to end through the real shells each generation uses (Bun's `$` on V1,
 * `node:child_process` on V2) against real hook scripts. Only local `sh`.
 */

const GUARD = `#!/bin/sh
payload=$(cat)
case "$payload" in
  *"rm -rf"*) echo "rm -rf is not allowed here" >&2; exit 2 ;;
  *"git push"*) echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no pushing"}}' ;;
  *"npm "*) echo '{"hookSpecificOutput":{"updatedInput":{"command":"pnpm install"},"additionalContext":"this repo uses pnpm"}}' ;;
esac
exit 0
`;

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "integration-"));
  await mkdir(join(dir, ".claude", "hooks"), { recursive: true });
  const guard = join(dir, ".claude", "hooks", "guard.sh");
  await writeFile(guard, GUARD);
  await chmod(guard, 0o755);
  await writeFile(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.sh' }] },
        ],
      },
    }),
  );
  return dir;
}

const client = { app: { log: async () => undefined } };

async function v1(dir: string, options: HooksPluginOptions) {
  // A fake input with only what the plugin reads: PluginInput is wider than that.
  const input = { $, client, directory: dir } as unknown as PluginInput;
  const hooks = await HooksPlugin(input, options);
  return async (args: Record<string, unknown>) => {
    const output = { args };
    await hooks["tool.execute.before"]?.({ tool: "bash", sessionID: "s", callID: "c" }, output);
    const result = { title: "", output: "ok", metadata: {} };
    await hooks["tool.execute.after"]?.({ tool: "bash", sessionID: "s", callID: "c", args }, result);
    return { args: output.args, output: result.output };
  };
}

describe("V1 through Bun's shell", () => {
  test("by default the guard runs and changes nothing", async () => {
    const before = await v1(await project(), {});
    expect(await before({ command: "rm -rf /tmp/x" })).toEqual({ args: { command: "rm -rf /tmp/x" }, output: "ok" });
    expect(await before({ command: "git push" })).toEqual({ args: { command: "git push" }, output: "ok" });
  });

  test("with preToolDecisions, exit 2 and deny block, updatedInput and context apply", async () => {
    const before = await v1(await project(), { preToolDecisions: true });
    // `label` names a command by its first quoted word, here "$CLAUDE_PROJECT_DIR".
    await expect(before({ command: "rm -rf /tmp/x" })).rejects.toThrow(
      "Blocked by PreToolUse hook $CLAUDE_PROJECT_DIR: rm -rf is not allowed here",
    );
    await expect(before({ command: "git push" })).rejects.toThrow("no pushing");
    expect(await before({ command: "npm install" })).toEqual({
      args: { command: "pnpm install" },
      output: "ok\n\n[PreToolUse hook context]\nthis repo uses pnpm",
    });
    expect(await before({ command: "ls" })).toEqual({ args: { command: "ls" }, output: "ok" });
  });

  test("with killOnTimeout, the same decisions hold through node:child_process", async () => {
    const before = await v1(await project(), { preToolDecisions: true, killOnTimeout: true });
    await expect(before({ command: "rm -rf /tmp/x" })).rejects.toThrow("rm -rf is not allowed here");
  });
});

describe("V2 through node:child_process", () => {
  type Handler = (event: Record<string, unknown>) => Promise<void> | void;

  async function v2(dir: string, options: HooksPluginOptions) {
    const toolHooks = new Map<string, Handler>();
    const register = async (name: string, callback: Handler) => {
      toolHooks.set(name, callback);
      return { dispose: async () => {} };
    };
    const ctx = {
      app: { name: "opencode", version: "2.3.2", channel: "latest" },
      options,
      location: { directory: dir },
      session: { hook: register },
      tool: { hook: register },
    };
    // A fake context with only what the plugin reads: the SDK's is wider than that.
    await createHooksPluginV2({ log: () => undefined }).setup(ctx as unknown as Parameters<Plugin["setup"]>[0]);
    return toolHooks;
  }

  test("by default the guard runs and changes nothing", async () => {
    const hooks = await v2(await project(), {});
    const event = { tool: "shell", sessionID: "s", id: "c", input: { command: "rm -rf /tmp/x" } };
    await hooks.get("execute.before")?.(event);
    expect(event.input).toEqual({ command: "rm -rf /tmp/x" });
  });

  test("with preToolDecisions, a deny rejects and updatedInput replaces the input", async () => {
    const hooks = await v2(await project(), { preToolDecisions: true });
    await expect(
      hooks.get("execute.before")?.({ tool: "shell", sessionID: "s", id: "c", input: { command: "git push" } }),
    ).rejects.toThrow("no pushing");
    const event = { tool: "shell", sessionID: "s", id: "d", input: { command: "npm install" } };
    await hooks.get("execute.before")?.(event);
    expect(event.input).toEqual({ command: "pnpm install" });
  });
});
