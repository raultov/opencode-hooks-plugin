import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { parseControl } from "./control.js";
import { DEFAULT_MATCHERS, hooksFileCandidates, readHooksFile, resolveCommands } from "./hooks-file.js";

export type { Control, Directive } from "./control.js";
export type { HookEntry, HooksFile, MatcherGroup, ResolvedCommand } from "./hooks-file.js";

/** Options accepted from `opencode.json` or when wrapping the plugin. */
export type HooksPluginOptions = {
  /**
   * Value `${CLAUDE_PLUGIN_ROOT}` expands to, and the directory probed for a
   * hooks file. Defaults to `$OPENCODE_HOOKS_ROOT`, then the project directory.
   */
  root?: string;
  /**
   * Explicit path to a hooks file. When omitted, `<root>/hooks/hooks.json` and
   * `<root>/.claude/settings.json` are probed in that order.
   * Defaults to `$OPENCODE_HOOKS_FILE`.
   */
  hooksFile?: string;
  /** Matcher values to honour. Defaults to `["startup", "resume", ""]`. */
  matchers?: string[];
  /** Substrings identifying commands to skip. Defaults to none. */
  skip?: string[];
  /**
   * How long the first model call waits for the commands to finish, in ms.
   * They keep running in the background past this. Defaults to 20000.
   */
  timeoutMs?: number;
  /** Whether `systemMessage` directives are appended to the system prompt. Defaults to true. */
  injectSystemMessages?: boolean;
  /** Extra environment variables exported to every command. */
  env?: Record<string, string>;
};

/** The only Claude Code event bridged today. See the README for why. */
const EVENT = "SessionStart";

const DEFAULT_TIMEOUT_MS = 20_000;

/** Shortens a command to something readable in a log line. */
function label(command: string, root: string): string {
  return (command.split(" ")[0] ?? command).replaceAll(`${root}/`, "").replaceAll('"', "");
}

/**
 * Bridges Claude Code `SessionStart` hooks to opencode.
 *
 * opencode has no `hooks` key in its config schema and never reads Claude
 * Code's hooks files. Its only startup extension point is the plugin function
 * body, which runs once when the plugin loads — that is what this maps onto:
 *
 * | Claude Code                     | opencode                              |
 * | ------------------------------- | ------------------------------------- |
 * | `SessionStart` + matcher        | this plugin function body             |
 * | `${CLAUDE_PLUGIN_ROOT}`         | the `root` option                     |
 * | stdout `{ systemMessage: ... }` | `experimental.chat.system.transform`  |
 * | stdout `{ continue: false }`    | remaining commands are skipped        |
 *
 * The hooks file is read at runtime rather than baked in, so edits to it are
 * picked up without touching this plugin.
 */
export const HooksPlugin: Plugin = async ({ $, client, directory }: PluginInput, options: HooksPluginOptions = {}) => {
  const root = options.root ?? process.env.OPENCODE_HOOKS_ROOT ?? directory;
  const candidates = hooksFileCandidates(root, options.hooksFile ?? process.env.OPENCODE_HOOKS_FILE);
  const matchers = options.matchers ?? [...DEFAULT_MATCHERS];
  const skip = options.skip ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const injectSystemMessages = options.injectSystemMessages ?? true;

  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void> =>
    client.app
      .log({ body: { service: "opencode-hooks", level, message, ...(extra ? { extra } : {}) } })
      .then(() => undefined)
      .catch(() => undefined);

  let found: Awaited<ReturnType<typeof readHooksFile>>;
  try {
    found = await readHooksFile(candidates);
  } catch (error) {
    await log("warn", "hooks file is not valid JSON — nothing bridged", {
      candidates,
      error: String(error),
    });
    return {};
  }

  if (!found) {
    await log("debug", "no hooks file found — nothing bridged", { candidates });
    return {};
  }

  const commands = resolveCommands(found.file, EVENT, root, matchers, skip);
  if (commands.length === 0) {
    await log("debug", `no ${EVENT} commands to bridge`, { hooksFile: found.path });
    return {};
  }

  /** `systemMessage` directives collected from the commands, in order. */
  const systemMessages: string[] = [];

  // Commands run sequentially to preserve the order declared in the hooks file.
  // This is deliberately not awaited here: opencode awaits the plugin function,
  // so awaiting the commands would stall startup on every launch.
  const bootstrap = (async () => {
    // CLAUDE_PLUGIN_ROOT is exported because hook scripts often read it too.
    // CLAUDE_CODE_ENTRYPOINT is deliberately left alone: scripts use it to gate
    // Claude-Code-only behaviour, and we are not Claude Code.
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: root,
      ...options.env,
    } as Record<string, string>;

    for (const { command, description } of commands) {
      const name = label(command, root);
      try {
        const result = await $`sh -c ${command}`.cwd(directory).env(env).quiet().nothrow();
        const { systemMessage, halt } = parseControl(result.stdout.toString());

        if (systemMessage) systemMessages.push(systemMessage);

        if (result.exitCode === 0) {
          await log("debug", `${name} ok`, { description });
        } else {
          await log("warn", `${name} exited ${result.exitCode}`, {
            description,
            stderr: result.stderr.toString().trim().slice(-2000),
          });
        }

        if (halt) {
          await log("warn", `${name} requested continue:false — skipping remaining commands`);
          break;
        }
      } catch (error) {
        // Soft-fail: a broken or missing hook script must never break the session.
        await log("error", `${name} threw`, { error: String(error) });
      }
    }

    if (systemMessages.length > 0) {
      await log("info", `bridged ${systemMessages.length} system message(s)`);
    }
  })();

  bootstrap.catch(() => undefined);

  let settled = false;
  const awaitBootstrap = async (): Promise<void> => {
    if (settled) return;
    await Promise.race([bootstrap, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    settled = true;
  };

  if (!injectSystemMessages) return {};

  return {
    // opencode's closest equivalent to Claude Code's `systemMessage`. This fires
    // on every model call and `output.system` is rebuilt each time, so pushing a
    // single block here is idempotent.
    "experimental.chat.system.transform": async (_input, output) => {
      await awaitBootstrap();
      if (systemMessages.length === 0) return;
      output.system.push([`## ${EVENT} hooks`, ...systemMessages].join("\n"));
    },
  };
};

export default HooksPlugin;
