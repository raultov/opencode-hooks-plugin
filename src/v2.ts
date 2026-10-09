import { spawn } from "node:child_process";
// Deep path on purpose: it resolves to the tiny `define` helper alone, while
// the package root re-exports the whole SDK barrel and would drag it into the
// bundle. Same `Plugin.define` the plugin guide shows.
import { define, type Plugin } from "@opencode/plugin/promise/plugin";
import { createBridge, type Exec, type HooksPluginOptions, type Log } from "./bridge.js";

/**
 * Bridges Claude Code `SessionStart` hooks to opencode V2.
 *
 * The bridging contract is identical to V1's (see `bridge.ts`); V2 differs in
 * mechanics:
 *
 * | Claude Code                     | opencode V2                           |
 * | ------------------------------- | ------------------------------------- |
 * | `SessionStart` + matcher        | the `setup` body (runs once at load)  |
 * | `${CLAUDE_PLUGIN_ROOT}`         | the `root` option                     |
 * | stdout `{ systemMessage: ... }` | `session.hook("context", ...)` & co.  |
 * | stdout `{ continue: false }`    | remaining commands are skipped        |
 *
 * V1's `experimental.chat.system.transform` fired on every model call, and V2
 * splits those by request kind, so the block is offered to every kind that
 * carries a system prompt: the agent loop (`context`) plus the auxiliary
 * `compaction`, `generate`, and `title` calls.
 */
const CONTEXT_KINDS = ["context", "compaction", "generate", "title"] as const;

/**
 * `node:child_process` execution: `sh -c` with stdin from `/dev/null`, so a
 * hook that reads stdin by accident sees EOF instead of hanging the chain.
 *
 * stdout and stderr are drained as they arrive, so a command abandoned after
 * its budget keeps running without blocking on a full pipe. Like V1, it is
 * never killed.
 */
export const nodeExec: Exec = (command, { cwd, env }) =>
  new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
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
 * Console transport. V2's plugin context exposes no log call (its `app` is
 * name/version/channel only), so diagnostics go to the console, which opencode
 * captures in its log.
 */
export const consoleLog: Log = (level, message, extra) => {
  const line = `[opencode-hooks] ${message}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "debug") console.debug(line);
  else console.log(line);
};

/** Injectable collaborators, for tests. Production uses the defaults. */
export type HooksPluginV2Dependencies = {
  exec?: Exec;
  log?: Log;
};

/** Builds the V2 plugin definition, optionally with test doubles. */
export function createHooksPluginV2(dependencies: HooksPluginV2Dependencies = {}): Plugin {
  const exec = dependencies.exec ?? nodeExec;
  const log = dependencies.log ?? consoleLog;

  return define({
    id: "opencode-hooks",
    setup: async (ctx) => {
      const options = ctx.options as HooksPluginOptions;
      const bridge = await createBridge(options, {
        directory: ctx.location.directory,
        exec,
        log,
      });
      if (!bridge.hasCommands || !bridge.inject) return;

      for (const kind of CONTEXT_KINDS) {
        await ctx.session.hook(kind, async (event) => {
          await bridge.awaitBootstrap();
          const block = bridge.systemBlock();
          if (!block) return;
          // Same guard as V1: a request that already carries the block keeps
          // only one copy, so the block cannot grow unbounded.
          if (event.system.some((part) => part.text === block)) return;
          event.system.push({ type: "text", text: block });
        });
      }
    },
  });
}

/** The V2 plugin entrypoint. */
export const HooksPluginV2 = createHooksPluginV2();

export default HooksPluginV2;
