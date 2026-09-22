import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { parseControl } from "./control.js";
import {
  blankSkipNeedles,
  DEFAULT_MATCHERS,
  hooksFileCandidates,
  readHooksFile,
  resolveCommands,
} from "./hooks-file.js";

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
  /**
   * How long a single command is waited for before moving on to the next, in
   * ms. Bounds each command, unlike `timeoutMs` which bounds the whole wait.
   * Defaults to 120000.
   */
  commandTimeoutMs?: number;
  /** Whether `systemMessage` directives are appended to the system prompt. Defaults to true. */
  injectSystemMessages?: boolean;
  /**
   * Whether a command that fails, times out or throws adds a one-line notice to
   * the system prompt, so the model knows its context is incomplete.
   * Never carries stderr, which stays in the log. Defaults to true.
   */
  reportFailures?: boolean;
  /** Extra environment variables exported to every command. */
  env?: Record<string, string>;
};

/** The only Claude Code event bridged today. See the README for why. */
const EVENT = "SessionStart";

const DEFAULT_TIMEOUT_MS = 20_000;

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Returned instead of a result when a command outlived its budget. */
const TIMED_OUT = Symbol("timed-out");

/**
 * Shortens a command to something readable in a log line.
 *
 * Takes the first argument whole, quotes included, so a path containing spaces
 * is not cut in half.
 */
function label(command: string, root: string): string {
  const first = command.trim().match(/^"[^"]*"|^'[^']*'|^\S+/)?.[0] ?? command;
  return first.replaceAll(`${root}/`, "").replaceAll('"', "").replaceAll("'", "");
}

/**
 * Resolves with `TIMED_OUT` once `ms` elapse, whatever `work` goes on to do.
 *
 * Bun's `$` returns a plain promise with no kill or abort API (checked against
 * Bun 1.3), so a command that overruns is abandoned, not killed: it keeps
 * running, orphaned, until it exits on its own. Giving up on the wait is what
 * matters here — the starvation comes from the await, not from the process.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  const explicitHooksFile = options.hooksFile ?? process.env.OPENCODE_HOOKS_FILE;
  const candidates = hooksFileCandidates(root, explicitHooksFile);
  const matchers = options.matchers ?? [...DEFAULT_MATCHERS];
  const skip = options.skip ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const injectSystemMessages = options.injectSystemMessages ?? true;
  const reportFailures = options.reportFailures ?? true;

  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void> =>
    client.app
      .log({ body: { service: "opencode-hooks", level, message, ...(extra ? { extra } : {}) } })
      .then(() => undefined)
      .catch(() => undefined);

  // A blank needle would match every command and bridge nothing. It is ignored,
  // but someone wrote it meaning something, so say so.
  const blanks = blankSkipNeedles(skip);
  if (blanks.length > 0) {
    await log("warn", `ignoring ${blanks.length} blank skip entry(s) — a blank one would skip every command`, { skip });
  }

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
    // Probing the defaults and finding nothing is the normal case for a project
    // with no hooks. A path someone typed out and got wrong is a misconfiguration.
    if (explicitHooksFile) {
      await log("warn", "configured hooks file does not exist — nothing bridged", { hooksFile: explicitHooksFile });
    } else {
      await log("debug", "no hooks file found — nothing bridged", { candidates });
    }
    return {};
  }

  const commands = resolveCommands(found.file, EVENT, root, matchers, skip);
  if (commands.length === 0) {
    await log("debug", `no ${EVENT} commands to bridge`, { hooksFile: found.path });
    return {};
  }

  /** `systemMessage` directives collected from the commands, in order. */
  const systemMessages: string[] = [];

  /**
   * Tells the model a hook did not deliver, so it knows its context is partial
   * rather than complete. Deliberately carries no stderr: that can hold secrets
   * and it is already in the log.
   */
  const reportFailure = (name: string, what: string): void => {
    if (reportFailures) systemMessages.push(`⚠️ hook ${name} ${what} — its context may be missing`);
  };

  // Commands run sequentially to preserve the order declared in the hooks file.
  // This is deliberately not awaited here: opencode awaits the plugin function,
  // so awaiting the commands would stall startup on every launch.
  const bootstrap = (async () => {
    // CLAUDE_PLUGIN_ROOT is exported because hook scripts often read it too.
    // CLAUDE_CODE_ENTRYPOINT is deliberately left alone: scripts use it to gate
    // Claude-Code-only behaviour, and we are not Claude Code.
    const env: Record<string, string> = {
      // process.env values are string | undefined, so the unset ones are dropped
      // rather than asserted away.
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      CLAUDE_PLUGIN_ROOT: root,
      ...options.env,
    };

    for (const { command, description } of commands) {
      const name = label(command, root);
      try {
        // stdin comes from /dev/null so a hook that reads it by accident sees
        // EOF instead of blocking the whole chain on a terminal that is not there.
        const started = $`sh -c ${command} < /dev/null`.cwd(directory).env(env).quiet().nothrow();
        const result = await withTimeout(started, commandTimeoutMs);

        if (result === TIMED_OUT) {
          await log("warn", `${name} outlived its ${commandTimeoutMs}ms budget — moving on`, { description });
          reportFailure(name, `timed out after ${commandTimeoutMs}ms`);
          continue;
        }

        const { systemMessage, halt } = parseControl(result.stdout.toString());

        if (systemMessage) systemMessages.push(systemMessage);

        if (result.exitCode === 0) {
          await log("debug", `${name} ok`, { description });
        } else {
          await log("warn", `${name} exited ${result.exitCode}`, {
            description,
            stderr: result.stderr.toString().trim().slice(-2000),
          });
          reportFailure(name, `exited ${result.exitCode}`);
        }

        if (halt) {
          await log("warn", `${name} requested continue:false — skipping remaining commands`);
          break;
        }
      } catch (error) {
        // Soft-fail: a broken or missing hook script must never break the session.
        await log("error", `${name} threw`, { error: String(error) });
        reportFailure(name, "failed to run");
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
    // on every model call. opencode is understood to rebuild `output.system`
    // each time, but this is an experimental hook that may change without
    // notice, so the block is only pushed when it is not already there — were
    // that assumption to break, the block would otherwise grow unbounded.
    "experimental.chat.system.transform": async (_input, output) => {
      await awaitBootstrap();
      if (systemMessages.length === 0) return;
      const block = [`## ${EVENT} hooks`, ...systemMessages].join("\n");
      if (!output.system.includes(block)) output.system.push(block);
    },
  };
};

export default HooksPlugin;
