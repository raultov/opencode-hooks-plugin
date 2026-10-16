import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { createBridge, type Exec, type HooksPluginOptions, type Log } from "./bridge.js";

/**
 * Bridges Claude Code `SessionStart` hooks to opencode V1.
 *
 * opencode V1 has no `hooks` key in its config schema and never reads Claude
 * Code's hooks files. Its only startup extension point is the plugin function
 * body, which runs once when the plugin loads — that is what this maps onto:
 *
 * | Claude Code                     | opencode V1                           |
 * | ------------------------------- | ------------------------------------- |
 * | `SessionStart` + matcher        | this plugin function body             |
 * | `PostToolUse` + matcher         | `tool.execute.after`                  |
 * | `${CLAUDE_PLUGIN_ROOT}`         | the `root` option                     |
 * | stdout `{ systemMessage: ... }` | `experimental.chat.system.transform`  |
 * | stdout `{ continue: false }`    | remaining commands are skipped        |
 *
 * The hooks file is read at runtime rather than baked in, so edits to it are
 * picked up without touching this plugin.
 */
export const HooksPlugin: Plugin = async ({ $, client, directory }: PluginInput, options: HooksPluginOptions = {}) => {
  const log: Log = (level, message, extra) =>
    client.app
      .log({ body: { service: "opencode-hooks", level, message, ...(extra ? { extra } : {}) } })
      .then(() => undefined)
      .catch(() => undefined);

  // Bun's `$` returns a plain promise with no kill or abort API (checked
  // against Bun 1.3), so an overrunning command is abandoned, not killed.
  const exec: Exec = (command, { cwd, env, stdin }) =>
    Promise.resolve(
      (stdin === undefined ? $`sh -c ${command} < /dev/null` : $`sh -c ${command} < ${Buffer.from(stdin)}`)
        .cwd(cwd)
        .env(env)
        .quiet()
        .nothrow(),
    ).then((result) => ({
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    }));

  const bridge = await createBridge(options, { directory, exec, log });
  const hooks: Hooks = {};

  if (bridge.hasToolCommands) {
    // Only fires for a call that returned: a tool that threw never reaches it,
    // as a failed call never reaches Claude Code's PostToolUse.
    hooks["tool.execute.after"] = async (input) => {
      await bridge.afterTool({ tool: input.tool, args: input.args, sessionID: input.sessionID });
    };
    // Fires before every model call, so it always holds the model the next
    // tool call came from.
    hooks["chat.params"] = async (input) => {
      bridge.noteModel(input.sessionID, input.model.id);
    };
  }

  if (!bridge.hasCommands || !bridge.inject) return hooks;

  return {
    ...hooks,
    // opencode's closest equivalent to Claude Code's `systemMessage`. This fires
    // on every model call. opencode is understood to rebuild `output.system`
    // each time, but this is an experimental hook that may change without
    // notice, so the block is only pushed when it is not already there — were
    // that assumption to break, the block would otherwise grow unbounded.
    "experimental.chat.system.transform": async (_input, output) => {
      await bridge.awaitBootstrap();
      const block = bridge.systemBlock();
      if (!block) return;
      if (!output.system.includes(block)) output.system.push(block);
    },
  };
};

export default HooksPlugin;
