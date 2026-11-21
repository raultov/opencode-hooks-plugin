import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { createBridge, type Exec, type HooksPluginOptions, type Log } from "./bridge.js";
import { spawnExec } from "./exec.js";

// opencode V1's built-in hidden agents. They run on the user's session but
// never call a tool, so their model is not the one a tool call came from.
const HIDDEN_AGENTS = new Set(["title", "summary", "compaction"]);

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
 * | `PreToolUse` + matcher          | `tool.execute.before`                 |
 * | `PostToolUse` + matcher         | `tool.execute.after`                  |
 * | `${CLAUDE_PLUGIN_ROOT}`         | the `root` option                     |
 * | stdout `{ systemMessage: ... }` | `experimental.chat.system.transform`  |
 * | stdout `{ continue: false }`    | remaining commands are skipped        |
 * | `PreToolUse` deny / exit 2      | `tool.execute.before` throws (opt-in) |
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
  // `killOnTimeout` needs a process it can signal, so it swaps in
  // `node:child_process`, which Bun implements; by default `$` stays.
  const exec: Exec = options.killOnTimeout === true ? spawnExec : bunExec($);

  const bridge = await createBridge(options, { directory, exec, log });
  const hooks: Hooks = {};

  if (bridge.hasPreToolCommands) {
    // Awaited before the call runs, so a hook sees the tree as the tool found
    // it. V1 hands the arguments over in `output`, not `input`. With
    // `preToolDecisions`, throwing is how a V1 plugin refuses a call: opencode
    // fails it with the message, which the model reads.
    hooks["tool.execute.before"] = async (input, output) => {
      const outcome = await bridge.beforeTool({
        tool: input.tool,
        args: output.args,
        sessionID: input.sessionID,
        callID: input.callID,
      });
      if (outcome.block !== undefined) throw new Error(outcome.block);
      if (outcome.args !== undefined && typeof output.args === "object" && output.args !== null) {
        Object.assign(output.args, outcome.args);
      }
    };
  }

  if (bridge.hasToolCommands || bridge.decides) {
    // Only fires for a call that returned: a tool that threw never reaches it,
    // as a failed call never reaches Claude Code's PostToolUse.
    hooks["tool.execute.after"] = async (input, output) => {
      const context = bridge.takeContext(input.callID);
      if (context !== undefined) output.output = `${output.output}\n\n[PreToolUse hook context]\n${context}`;
      if (bridge.hasToolCommands) {
        await bridge.afterTool({ tool: input.tool, args: input.args, sessionID: input.sessionID });
      }
    };
  }

  if (bridge.hasToolCommands || bridge.hasPreToolCommands) {
    // Fires before every model call, so it always holds the model the next
    // tool call came from. V1 has no request kind, so its hidden agents are
    // skipped by name: their requests share the sessionID, and a title model
    // (often a small one) noted last would be stamped on the next tool call.
    hooks["chat.params"] = async (input) => {
      if (HIDDEN_AGENTS.has(input.agent)) return;
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

/** Runs a command through Bun's `$`, the shell opencode V1 hands its plugins. */
function bunExec($: PluginInput["$"]): Exec {
  return (command, { cwd, env, stdin }) =>
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
}

export default HooksPlugin;
