// Deep path on purpose: it resolves to the tiny `define` helper alone, while
// the package root re-exports the whole SDK barrel and would drag it into the
// bundle. Same `Plugin.define` the plugin guide shows.
import { define, type Plugin } from "@opencode/plugin/promise/plugin";
import type { Result } from "@opencode/plugin/promise/tool";
import { createBridge, type Exec, type HooksPluginOptions, type Log } from "./bridge.js";
import { spawnExec } from "./exec.js";

/**
 * Bridges Claude Code `SessionStart` hooks to opencode V2.
 *
 * The bridging contract is identical to V1's (see `bridge.ts`); V2 differs in
 * mechanics:
 *
 * | Claude Code                     | opencode V2                           |
 * | ------------------------------- | ------------------------------------- |
 * | `SessionStart` + matcher        | the `setup` body (runs once at load)  |
 * | `PreToolUse` + matcher          | `tool.hook("execute.before", ...)`    |
 * | `PostToolUse` + matcher         | `tool.hook("execute.after", ...)`     |
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
 * `node:child_process` execution, shared with V1's `killOnTimeout`: see
 * `spawnExec`. Never killed unless `killOnTimeout` passes it a signal.
 */
export const nodeExec: Exec = spawnExec;

/**
 * Whether the host fails a call when an `execute.before` hook rejects.
 *
 * Up to 2.0.28, opencode V2's promise adapter turned a rejected hook into a
 * defect rather than a failure of that one call; from 2.0.29 it fails the
 * call alone, with the rejection's message (checked in the published
 * `@opencode/plugin` adapters, which share opencode's version number). A
 * version that does not read as one (a dev or local build, `0.0.0-…`) is
 * taken to be current.
 */
export function canFailToolCalls(version: string | undefined): boolean {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return true;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (major === 0) return true;
  if (major !== 2) return major > 2;
  return minor > 0 || patch >= 29;
}

/**
 * The call's result with `PreToolUse` context added for the model: appended to
 * text content, or as one more text part. A result with no content is
 * returned as it was, since there is nothing the model reads to add to.
 */
export function withContext(result: Result, context: string): Result {
  const text = `[PreToolUse hook context]\n${context}`;
  if (typeof result.content === "string") return { ...result, content: `${result.content}\n\n${text}` };
  if (Array.isArray(result.content)) return { ...result, content: [...result.content, { type: "text", text }] };
  return result;
}

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

      // The test doubles carry no `app`; a real host always does.
      const version: string | undefined = ctx.app?.version;
      const canBlock = canFailToolCalls(version);
      if (bridge.decides && !canBlock) {
        await Promise.resolve(
          log(
            "warn",
            `preToolDecisions: opencode ${version} cannot fail a call from a plugin hook (2.0.29 or newer can) — denials are logged, the calls go ahead`,
          ),
        ).catch(() => undefined);
      }

      if (bridge.hasPreToolCommands) {
        // Awaited before the call runs, so a hook sees the tree as the tool
        // found it. With `preToolDecisions`, a rejection is how a V2 plugin
        // refuses a call: opencode fails it with the message.
        await ctx.tool.hook("execute.before", async (event) => {
          const outcome = await bridge.beforeTool({
            tool: event.tool,
            args: event.input,
            sessionID: event.sessionID,
            callID: event.id,
          });
          if (outcome.block !== undefined) {
            if (canBlock) throw new Error(outcome.block);
            return;
          }
          if (outcome.args !== undefined) {
            const input = typeof event.input === "object" && event.input !== null ? event.input : {};
            event.input = { ...input, ...outcome.args };
          }
        });
      }

      if (bridge.hasToolCommands || bridge.decides) {
        // Only a completed call: Claude Code's PostToolUse does not fire for a
        // tool that failed either.
        await ctx.tool.hook("execute.after", async (event) => {
          if (event.status !== "completed") {
            bridge.takeContext(event.id);
            return;
          }
          const context = bridge.takeContext(event.id);
          if (context !== undefined) event.result = withContext(event.result, context);
          if (!bridge.hasToolCommands) return;
          await bridge.afterTool({ tool: event.tool, args: event.input, sessionID: event.sessionID });
        });
      }

      if (bridge.hasToolCommands || bridge.hasPreToolCommands) {
        // Fires before every model call, so it always holds the model the next
        // tool call came from. Only the session's own turns: the title and
        // compaction requests share its sessionID, and a title model (often a
        // small one) noted last would be stamped on the next tool call.
        await ctx.session.hook("model.request", (event) => {
          if (event.kind !== "primary") return;
          bridge.noteModel(event.sessionID, event.model.id);
        });
      }

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
