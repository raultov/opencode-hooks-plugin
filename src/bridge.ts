import { parseControl } from "./control.js";
import {
  blankSkipNeedles,
  DEFAULT_MATCHERS,
  hooksFileCandidates,
  matchesTool,
  readHooksFile,
  resolveCommands,
  resolveToolCommands,
} from "./hooks-file.js";
import { toClaudeToolCalls } from "./tools.js";

/**
 * Shared engine behind the OpenCode V1 and V2 entrypoints.
 *
 * Both generations map Claude Code's `SessionStart` event the same way: run
 * the bridged commands once when the plugin loads, then surface their control
 * directives to the model. `PostToolUse` commands run after each opencode tool
 * call that has a Claude Code counterpart. Only the mechanics differ per generation — how a
 * command is executed and where diagnostics go — so those two concerns are
 * injected here and the bridging contract lives in one place.
 */

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

/** What a finished command produced. */
export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * Runs one shell line to completion, with `stdin` as its standard input, or
 * `/dev/null` when there is none.
 *
 * V1 plugs Bun's `$` in here, V2 plugs in `node:child_process`. Neither
 * generation kills an overrunning command: giving up on the wait is what
 * bounds the chain, and killing a bootstrap command half-way (an install, a
 * sync) could leave its work in a worse state than letting it finish.
 */
export type Exec = (
  command: string,
  options: { cwd: string; env: Record<string, string>; stdin?: string },
) => Promise<CommandResult>;

/** Diagnostic severity, shared by both generations' log transports. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Receives the plugin's diagnostics. Failures here are swallowed. */
export type Log = (level: LogLevel, message: string, extra?: Record<string, unknown>) => Promise<void> | void;

/** The Claude Code event run once, when the plugin loads. */
export const EVENT = "SessionStart";

/** The Claude Code event run after each tool call. See the README for the tool mapping. */
export const TOOL_EVENT = "PostToolUse";

export const DEFAULT_TIMEOUT_MS = 20_000;

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Returned instead of a result when a command outlived its budget. */
const TIMED_OUT = Symbol("timed-out");

/**
 * Shortens a command to something readable in a log line.
 *
 * Takes the first argument whole, quotes included, so a path containing spaces
 * is not cut in half.
 */
export function label(command: string, root: string): string {
  const first = command.trim().match(/^"[^"]*"|^'[^']*'|^\S+/)?.[0] ?? command;
  return first.replaceAll(`${root}/`, "").replaceAll('"', "").replaceAll("'", "");
}

/**
 * Resolves with `TIMED_OUT` once `ms` elapse, whatever `work` goes on to do.
 *
 * The losing promise is abandoned, not cancelled: a command that overruns is
 * left running (neither generation's shell exposes a kill API worth relying
 * on), it is the wait that is given up on. The starvation this bounds comes
 * from the await, not from the process.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
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

/** The bridged work a generation-specific entrypoint drives. */
export type Bridge = {
  /** False when no `SessionStart` command was bridged. */
  readonly hasCommands: boolean;
  /** False when no `PostToolUse` command was bridged. */
  readonly hasToolCommands: boolean;
  /** Whether `systemMessage` directives should reach the system prompt. */
  readonly inject: boolean;
  /** Waits for the commands, at most `timeoutMs`. Settles at once on later calls. */
  awaitBootstrap(): Promise<void>;
  /** The system block to inject, or undefined when there is nothing to say. */
  systemBlock(): string | undefined;
  /** Runs the `PostToolUse` commands matching one finished opencode tool call. */
  afterTool(call: { tool: string; args: unknown; sessionID: string }): Promise<void>;
  /** Records the model a session last called, for the `PostToolUse` payload. */
  noteModel(sessionID: string, model: string): void;
};

/** A bridge with nothing to run, for the early exits. */
function idleBridge(inject: boolean): Bridge {
  return {
    hasCommands: false,
    hasToolCommands: false,
    inject,
    awaitBootstrap: () => Promise.resolve(),
    systemBlock: () => undefined,
    afterTool: () => Promise.resolve(),
    noteModel: () => undefined,
  };
}

/**
 * Resolves the options, picks the hooks file, and starts the command chain.
 *
 * The chain is deliberately not awaited: every launch would otherwise pay the
 * full runtime of the hooks. `awaitBootstrap` is how the first model call waits
 * for the directives, bounded by `timeoutMs`.
 */
export async function createBridge(
  options: HooksPluginOptions,
  deps: { directory: string; exec: Exec; log: Log },
): Promise<Bridge> {
  const root = options.root ?? process.env.OPENCODE_HOOKS_ROOT ?? deps.directory;
  const explicitHooksFile = options.hooksFile ?? process.env.OPENCODE_HOOKS_FILE;
  const candidates = hooksFileCandidates(root, explicitHooksFile);
  const matchers = options.matchers ?? [...DEFAULT_MATCHERS];
  const skip = options.skip ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const inject = options.injectSystemMessages ?? true;
  const reportFailures = options.reportFailures ?? true;

  // A dying log transport must never take the plugin down with it.
  const log = (level: LogLevel, message: string, extra?: Record<string, unknown>): Promise<void> =>
    Promise.resolve(deps.log(level, message, extra)).then(
      () => undefined,
      () => undefined,
    );

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
    return idleBridge(inject);
  }

  if (!found) {
    // Probing the defaults and finding nothing is the normal case for a project
    // with no hooks. A path someone typed out and got wrong is a misconfiguration.
    if (explicitHooksFile) {
      await log("warn", "configured hooks file does not exist — nothing bridged", { hooksFile: explicitHooksFile });
    } else {
      await log("debug", "no hooks file found — nothing bridged", { candidates });
    }
    return idleBridge(inject);
  }

  const commands = resolveCommands(found.file, EVENT, root, matchers, skip);
  const toolCommands = resolveToolCommands(found.file, TOOL_EVENT, root, skip);
  if (commands.length === 0 && toolCommands.length === 0) {
    await log("debug", `no ${EVENT} or ${TOOL_EVENT} commands to bridge`, { hooksFile: found.path });
    return idleBridge(inject);
  }

  // CLAUDE_PLUGIN_ROOT and CLAUDE_PROJECT_DIR are exported because hook scripts
  // often read them too: `.claude/settings.json` hooks are usually invoked as
  // "$CLAUDE_PROJECT_DIR"/.claude/hooks/…. CLAUDE_CODE_ENTRYPOINT is
  // deliberately left alone: scripts use it to gate Claude-Code-only
  // behaviour, and we are not Claude Code.
  const env: Record<string, string> = {
    // process.env values are string | undefined, so the unset ones are dropped
    // rather than asserted away.
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    CLAUDE_PLUGIN_ROOT: root,
    CLAUDE_PROJECT_DIR: deps.directory,
    ...options.env,
  };

  // What Claude Code writes to a SessionStart hook's stdin, minus what opencode
  // cannot supply: no session exists yet when the plugin loads, and there is no
  // Claude Code transcript to point at.
  const sessionStartInput = JSON.stringify({ hook_event_name: EVENT, source: "startup", cwd: deps.directory });

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
  const bootstrap = (async () => {
    for (const { command, description } of commands) {
      const name = label(command, root);
      try {
        // stdin carries the event payload and then ends, so a hook that reads
        // it sees EOF instead of blocking the chain on a terminal not there.
        const result = await withTimeout(
          deps.exec(command, { cwd: deps.directory, env, stdin: sessionStartInput }),
          commandTimeoutMs,
        );

        if (result === TIMED_OUT) {
          await log("warn", `${name} outlived its ${commandTimeoutMs}ms budget — moving on`, { description });
          reportFailure(name, `timed out after ${commandTimeoutMs}ms`);
          continue;
        }

        const { systemMessage, halt } = parseControl(result.stdout);

        if (systemMessage) systemMessages.push(systemMessage);

        if (result.exitCode === 0) {
          await log("debug", `${name} ok`, { description });
        } else {
          await log("warn", `${name} exited ${result.exitCode}`, {
            description,
            stderr: result.stderr.trim().slice(-2000),
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

  /**
   * Runs the matching `PostToolUse` commands in order, each awaited like Claude
   * Code does, so a hook that inspects the working tree sees the tool's effect
   * before the next call. Each is bounded by `commandTimeoutMs`, and a failure
   * is logged only: the tool already ran, and its hooks are bookkeeping that
   * must never interrupt the session. stdout directives are not honoured.
   */
  /**
   * The model each session last called. Claude Code puts `model` in its
   * SessionStart payload only; opencode can switch models mid-session, so the
   * latest call is what a tool call is attributed to. Subagents run in their
   * own sessions, so each is attributed to its own model.
   */
  const models = new Map<string, string>();

  const afterTool = async ({ tool, args, sessionID }: { tool: string; args: unknown; sessionID: string }) => {
    if (toolCommands.length === 0) return;
    const model = models.get(sessionID);
    for (const call of toClaudeToolCalls(tool, args, deps.directory)) {
      const matching = toolCommands.filter(({ matcher }) => matchesTool(matcher, call.tool_name));
      if (matching.length === 0) continue;
      const stdin = JSON.stringify({
        session_id: sessionID,
        cwd: deps.directory,
        hook_event_name: TOOL_EVENT,
        ...(model ? { model } : {}),
        ...call,
      });
      for (const { command, description } of matching) {
        const name = label(command, root);
        try {
          const result = await withTimeout(deps.exec(command, { cwd: deps.directory, env, stdin }), commandTimeoutMs);
          if (result === TIMED_OUT) {
            await log("warn", `${name} outlived its ${commandTimeoutMs}ms budget on ${call.tool_name}`, {
              description,
            });
          } else if (result.exitCode !== 0) {
            await log("warn", `${name} exited ${result.exitCode} on ${call.tool_name}`, {
              description,
              stderr: result.stderr.trim().slice(-2000),
            });
          }
        } catch (error) {
          await log("error", `${name} threw on ${call.tool_name}`, { error: String(error) });
        }
      }
    }
  };

  return {
    hasCommands: commands.length > 0,
    hasToolCommands: toolCommands.length > 0,
    inject,
    awaitBootstrap,
    systemBlock: () => (systemMessages.length > 0 ? [`## ${EVENT} hooks`, ...systemMessages].join("\n") : undefined),
    afterTool,
    noteModel: (sessionID, model) => {
      models.set(sessionID, model);
    },
  };
}
