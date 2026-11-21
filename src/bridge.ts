import { parseControl, parseToolDecision } from "./control.js";
import {
  BRIDGED_EVENTS,
  blankSkipNeedles,
  DEFAULT_MATCHERS,
  hooksFileCandidates,
  matchesTool,
  type ResolvedCommand,
  readHooksFile,
  resolveCommands,
  resolveToolCommands,
  unsupportedHooks,
} from "./hooks-file.js";
import { toClaudeToolCalls, toOpencodeArgs } from "./tools.js";
import { defaultApprovalsFile, fingerprint, isInside, readApprovals, type TrustMode } from "./trust.js";

/**
 * Shared engine behind the OpenCode V1 and V2 entrypoints.
 *
 * Both generations map Claude Code's `SessionStart` event the same way: run
 * the bridged commands once when the plugin loads, then surface their control
 * directives to the model. `PreToolUse` and `PostToolUse` commands run before
 * and after each opencode tool call that has a Claude Code counterpart. Only the mechanics differ per generation — how a
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
  /**
   * Whether `PreToolUse` commands decide about the call, as in Claude Code:
   * exit code 2 or a `deny` blocks it, `updatedInput` rewrites its arguments,
   * `additionalContext` is added to its result. Defaults to false: the
   * commands run and are logged, and nothing they return changes the call.
   */
  preToolDecisions?: boolean;
  /**
   * With `preToolDecisions`, whether a `PreToolUse` command that times out,
   * fails to start or exits with a code other than 0 or 2 blocks the call.
   * Defaults to false: such a failure is logged and the call goes ahead.
   */
  failClosed?: boolean;
  /**
   * Whether a command that outlives `commandTimeoutMs` is killed, together with
   * every process it started. Defaults to false: it is left to finish.
   */
  killOnTimeout?: boolean;
  /**
   * `"all"` runs every bridged command. `"approved"` runs a command from a
   * hooks file inside the project directory only once it has been approved
   * (see `approvalsFile`). Defaults to `"all"`.
   */
  trust?: TrustMode;
  /**
   * Where `trust: "approved"` reads approvals from. Defaults to
   * `$XDG_CONFIG_HOME/opencode-hooks/approved.json`, else `~/.config/…`.
   */
  approvalsFile?: string;
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
 * V1 plugs Bun's `$` in here, V2 plugs in `node:child_process`. By default
 * neither generation kills an overrunning command: giving up on the wait is
 * what bounds the chain, and killing a bootstrap command half-way (an install,
 * a sync) could leave its work in a worse state than letting it finish. With
 * `killOnTimeout`, `signal` is passed and aborted once the budget is spent,
 * and the command is expected to be killed.
 */
export type Exec = (
  command: string,
  options: { cwd: string; env: Record<string, string>; stdin?: string; signal?: AbortSignal },
) => Promise<CommandResult>;

/** Diagnostic severity, shared by both generations' log transports. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Receives the plugin's diagnostics. Failures here are swallowed. */
export type Log = (level: LogLevel, message: string, extra?: Record<string, unknown>) => Promise<void> | void;

/** The Claude Code event run once, when the plugin loads. */
export const EVENT = "SessionStart";

/** The Claude Code event run after each tool call. See the README for the tool mapping. */
export const TOOL_EVENT = "PostToolUse";

/** The Claude Code event run before each tool call. Same tool mapping as `TOOL_EVENT`. */
export const PRE_TOOL_EVENT = "PreToolUse";

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

/** One opencode tool call, as the tool hooks see it. */
export type ToolCallInput = {
  tool: string;
  args: unknown;
  sessionID: string;
  /** Pairs a call's `PreToolUse` context with its result. Optional for callers that have none. */
  callID?: string;
};

/**
 * What the `PreToolUse` commands decided about a call. Empty unless
 * `preToolDecisions` is on, so by default a call always goes ahead untouched.
 */
export type PreToolOutcome = {
  /** Set when the call must not run: the reason the model is given. */
  block?: string;
  /** opencode arguments to overwrite before the call runs. */
  args?: Record<string, unknown>;
};

/** The bridged work a generation-specific entrypoint drives. */
export type Bridge = {
  /** False when no `SessionStart` command was bridged. */
  readonly hasCommands: boolean;
  /** False when no `PostToolUse` command was bridged. */
  readonly hasToolCommands: boolean;
  /** False when no `PreToolUse` command was bridged. */
  readonly hasPreToolCommands: boolean;
  /** True when `PreToolUse` commands were bridged and `preToolDecisions` is on. */
  readonly decides: boolean;
  /** Whether `systemMessage` directives should reach the system prompt. */
  readonly inject: boolean;
  /** Waits for the commands, at most `timeoutMs`. Settles at once on later calls. */
  awaitBootstrap(): Promise<void>;
  /** The system block to inject, or undefined when there is nothing to say. */
  systemBlock(): string | undefined;
  /** Runs the `PreToolUse` commands matching one opencode tool call about to run. */
  beforeTool(call: ToolCallInput): Promise<PreToolOutcome>;
  /** Runs the `PostToolUse` commands matching one finished opencode tool call. */
  afterTool(call: ToolCallInput): Promise<void>;
  /** Hands over, once, the `additionalContext` the `PreToolUse` commands left for a call. */
  takeContext(callID: string): string | undefined;
  /** Records the model a session last called, for the tool payloads. */
  noteModel(sessionID: string, model: string): void;
};

/** A bridge with nothing to run, for the early exits. */
function idleBridge(inject: boolean): Bridge {
  return {
    hasCommands: false,
    hasToolCommands: false,
    hasPreToolCommands: false,
    decides: false,
    inject,
    awaitBootstrap: () => Promise.resolve(),
    systemBlock: () => undefined,
    beforeTool: () => Promise.resolve({}),
    afterTool: () => Promise.resolve(),
    takeContext: () => undefined,
    noteModel: () => undefined,
  };
}

/** How many calls' `additionalContext` is held at most, waiting for their result. */
const MAX_PENDING_CONTEXTS = 256;

/** The longest reason passed on to the model, in characters. */
const MAX_REASON_LENGTH = 2_000;

/** The shell line that approves a hooks file's commands, for the log. */
const approveCommand = (hooksFile: string, root: string): string =>
  `npx @raultov/opencode-hooks-plugin approve --hooks-file '${hooksFile}' --root '${root}'`;

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
  const preToolDecisions = options.preToolDecisions === true;
  const failClosed = options.failClosed === true;
  const killOnTimeout = options.killOnTimeout === true;
  // Anything but the default is read as the stricter mode: a typo made while
  // asking for approvals must not quietly run every project command.
  const trust: TrustMode = options.trust === undefined || options.trust === "all" ? "all" : "approved";

  // A dying log transport must never take the plugin down with it.
  const log = (level: LogLevel, message: string, extra?: Record<string, unknown>): Promise<void> =>
    Promise.resolve(deps.log(level, message, extra)).then(
      () => undefined,
      () => undefined,
    );

  if (options.trust !== undefined && options.trust !== "all" && options.trust !== "approved") {
    await log("warn", `unknown trust ${JSON.stringify(options.trust)} — treated as "approved"`);
  }
  if (failClosed && !preToolDecisions) {
    await log("warn", "failClosed has no effect without preToolDecisions");
  }

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

  // Hooks Claude Code would run and this plugin will not: said once, so a
  // missing `Stop` or `prompt` hook is not mistaken for a silent failure.
  const ignored = unsupportedHooks(found.file);
  if (ignored.length > 0) {
    await log("info", `not bridged (only ${BRIDGED_EVENTS.join(", ")} command hooks run): ${ignored.join(", ")}`, {
      hooksFile: found.path,
    });
  }

  let commands = resolveCommands(found.file, EVENT, root, matchers, skip);
  let toolCommands = resolveToolCommands(found.file, TOOL_EVENT, root, skip);
  let preToolCommands = resolveToolCommands(found.file, PRE_TOOL_EVENT, root, skip);

  // A hooks file outside the project was chosen by the user's own config; one
  // inside it came with whatever repository was opened.
  if (trust === "approved" && isInside(found.path, deps.directory)) {
    const hooksFile = found.path;
    const approvalsFile = options.approvalsFile ?? defaultApprovalsFile();
    let approved = new Set<string>();
    try {
      approved = new Set(Object.keys((await readApprovals(approvalsFile)).approved));
    } catch (error) {
      await log("warn", "approvals file is not valid JSON — no project hook is approved", {
        approvalsFile,
        error: String(error),
      });
    }

    const unapproved: Array<{ event: string; command: string; fingerprint: string }> = [];
    const approvedFor =
      (event: string) =>
      (entry: ResolvedCommand): boolean => {
        const id = fingerprint({ hooksFile, event, matcher: entry.matcher ?? "", command: entry.command });
        if (approved.has(id)) return true;
        unapproved.push({ event, command: label(entry.command, root), fingerprint: id });
        return false;
      };
    commands = commands.filter(approvedFor(EVENT));
    toolCommands = toolCommands.filter(approvedFor(TOOL_EVENT));
    preToolCommands = preToolCommands.filter(approvedFor(PRE_TOOL_EVENT));

    if (unapproved.length > 0) {
      await log(
        "warn",
        `${unapproved.length} project hook command(s) not approved — not run. Review and approve them with: ${approveCommand(hooksFile, root)}`,
        { hooksFile, approvalsFile, unapproved },
      );
    }
  }

  if (commands.length === 0 && toolCommands.length === 0 && preToolCommands.length === 0) {
    await log("debug", `no ${EVENT}, ${PRE_TOOL_EVENT} or ${TOOL_EVENT} commands to bridge`, { hooksFile: found.path });
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

  /**
   * Runs one command, bounded by `commandTimeoutMs`. With `killOnTimeout` the
   * command is handed a signal, aborted once the budget is spent.
   */
  const run = async (command: string, stdin: string): Promise<CommandResult | typeof TIMED_OUT> => {
    const controller = killOnTimeout ? new AbortController() : undefined;
    const result = await withTimeout(
      deps.exec(command, {
        cwd: deps.directory,
        env,
        stdin,
        ...(controller === undefined ? {} : { signal: controller.signal }),
      }),
      commandTimeoutMs,
    );
    if (result === TIMED_OUT) controller?.abort();
    return result;
  };

  /** How a command that outlived its budget was dealt with, for the log. */
  const overrun = killOnTimeout ? "killed" : "left running";

  // Commands run sequentially to preserve the order declared in the hooks file.
  const bootstrap = (async () => {
    for (const { command, description } of commands) {
      const name = label(command, root);
      try {
        // stdin carries the event payload and then ends, so a hook that reads
        // it sees EOF instead of blocking the chain on a terminal not there.
        const result = await run(command, sessionStartInput);

        if (result === TIMED_OUT) {
          await log("warn", `${name} outlived its ${commandTimeoutMs}ms budget — ${overrun}, moving on`, {
            description,
          });
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
   * The model each session last called. Claude Code puts `model` in its
   * SessionStart payload only; opencode can switch models mid-session, so the
   * latest call is what a tool call is attributed to. Subagents run in their
   * own sessions, so each is attributed to its own model.
   */
  const models = new Map<string, string>();

  /** `additionalContext` left by `PreToolUse` commands, by call, until the call's result takes it. */
  const contexts = new Map<string, string>();

  const keepContext = (callID: string | undefined, text: string): void => {
    if (callID === undefined) return;
    contexts.set(callID, text);
    // A call that throws never reaches its result on V1, so its entry would
    // stay: the oldest go once there are more than any session has in flight.
    for (const oldest of contexts.keys()) {
      if (contexts.size <= MAX_PENDING_CONTEXTS) break;
      contexts.delete(oldest);
    }
  };

  /** The reason the model is given for a blocked call. */
  const blocked = (name: string, reason: string): PreToolOutcome => {
    const text = reason.trim() === "" ? "no reason given" : reason.trim().slice(0, MAX_REASON_LENGTH);
    return { block: `Blocked by PreToolUse hook ${name}: ${text}` };
  };

  /**
   * Runs the matching tool-event commands in order, each awaited like Claude
   * Code does. After a call, a hook that inspects the working tree sees the
   * tool's effect; before one, it sees the tree as the tool found it. Each is
   * bounded by `commandTimeoutMs`, and a failure is logged only: tool hooks are
   * bookkeeping that must never interrupt the session.
   *
   * By default stdout directives and exit codes are not honoured, so a
   * `PreToolUse` hook cannot block a call. With `preToolDecisions` they are,
   * as Claude Code reads them: exit 2 blocks with stderr as the reason; on
   * exit 0, a `deny` blocks, `updatedInput` rewrites the arguments and
   * `additionalContext` is kept for the result. The first block ends the run:
   * the call will not happen, so nothing after it needs a say. Every command
   * is sent the call as the model made it, not as an earlier hook rewrote it,
   * as Claude Code runs them side by side.
   */
  const runToolCommands = async (
    event: typeof TOOL_EVENT | typeof PRE_TOOL_EVENT,
    commandsForEvent: typeof toolCommands,
    { tool, args, sessionID, callID }: ToolCallInput,
  ): Promise<PreToolOutcome> => {
    if (commandsForEvent.length === 0) return {};
    const decide = event === PRE_TOOL_EVENT && preToolDecisions;
    const model = models.get(sessionID);
    const rewritten: Record<string, unknown> = {};
    const notes: string[] = [];

    for (const call of toClaudeToolCalls(tool, args, deps.directory)) {
      const matching = commandsForEvent.filter(({ matcher }) => matchesTool(matcher, call.tool_name));
      if (matching.length === 0) continue;
      const stdin = JSON.stringify({
        session_id: sessionID,
        cwd: deps.directory,
        hook_event_name: event,
        ...(model ? { model } : {}),
        ...call,
      });
      for (const { command, description } of matching) {
        const name = label(command, root);
        let result: CommandResult | typeof TIMED_OUT;
        try {
          result = await run(command, stdin);
        } catch (error) {
          await log("error", `${name} threw on ${call.tool_name}`, { error: String(error) });
          if (decide && failClosed) return blocked(name, "the hook failed to run");
          continue;
        }

        if (result === TIMED_OUT) {
          await log("warn", `${name} outlived its ${commandTimeoutMs}ms budget on ${call.tool_name} — ${overrun}`, {
            description,
          });
          if (decide && failClosed) return blocked(name, `the hook did not answer within ${commandTimeoutMs}ms`);
          continue;
        }

        if (result.exitCode !== 0) {
          await log("warn", `${name} exited ${result.exitCode} on ${call.tool_name}`, {
            description,
            stderr: result.stderr.trim().slice(-2000),
          });
        }
        if (!decide) continue;

        // Claude Code's contract: exit 2 blocks and its stderr is written for
        // the model; any other failure is non-blocking unless failClosed.
        if (result.exitCode === 2) {
          await log("warn", `${name} denied ${call.tool_name} (exit 2)`, { description });
          return blocked(name, result.stderr);
        }
        if (result.exitCode !== 0) {
          if (failClosed) return blocked(name, `the hook exited ${result.exitCode}`);
          continue;
        }

        const verdict = parseToolDecision(result.stdout);
        if (verdict.additionalContext !== undefined) notes.push(verdict.additionalContext);
        if (verdict.decision === "deny") {
          await log("warn", `${name} denied ${call.tool_name}`, { description, reason: verdict.reason });
          return blocked(name, verdict.reason ?? "");
        }
        if (verdict.decision === "ask") {
          await log(
            "warn",
            `${name} asked for confirmation on ${call.tool_name}; a plugin cannot prompt, so opencode's own permission rules decide`,
          );
        }
        if (verdict.updatedInput !== undefined) {
          const changes = toOpencodeArgs(tool, args, call, verdict.updatedInput);
          if (changes === undefined) {
            await log(
              "warn",
              `${name} returned updatedInput for ${tool}, which has no single opencode counterpart — ignored`,
            );
          } else {
            Object.assign(rewritten, changes.args);
            if (changes.ignored.length > 0) {
              await log(
                "warn",
                `${name} updatedInput fields with no ${tool} argument ignored: ${changes.ignored.join(", ")}`,
              );
            }
          }
        }
      }
    }

    if (notes.length > 0) keepContext(callID, notes.join("\n"));
    return Object.keys(rewritten).length > 0 ? { args: rewritten } : {};
  };

  return {
    hasCommands: commands.length > 0,
    hasToolCommands: toolCommands.length > 0,
    hasPreToolCommands: preToolCommands.length > 0,
    decides: preToolDecisions && preToolCommands.length > 0,
    inject,
    awaitBootstrap,
    systemBlock: () => (systemMessages.length > 0 ? [`## ${EVENT} hooks`, ...systemMessages].join("\n") : undefined),
    beforeTool: (call) => runToolCommands(PRE_TOOL_EVENT, preToolCommands, call),
    afterTool: async (call) => {
      await runToolCommands(TOOL_EVENT, toolCommands, call);
    },
    takeContext: (callID) => {
      const text = contexts.get(callID);
      contexts.delete(callID);
      return text;
    },
    noteModel: (sessionID, model) => {
      models.set(sessionID, model);
    },
  };
}
