import { resolve } from "node:path";

/**
 * Translates opencode tool calls into the shape Claude Code hands its
 * `PreToolUse` and `PostToolUse` hooks, so a hook written for Claude Code
 * reads the same `tool_name` and `tool_input` under opencode.
 *
 * Only the tools that change files are translated. A hook matched on any other
 * Claude Code tool has no opencode counterpart this plugin can vouch for, so it
 * is not run rather than run against a guessed payload.
 */

/** One Claude Code tool call, as a `PreToolUse` or `PostToolUse` hook sees it. */
export type ClaudeToolCall = {
  tool_name: string;
  tool_input: Record<string, unknown>;
};

/** Patch headers that name a file `apply_patch` adds, changes, deletes or moves to. */
const PATCH_FILE = /^\*\*\* (Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/;

/**
 * The files an `apply_patch` call leaves on disk, in order, each once.
 *
 * A deleted file and the source of a move are left out: Claude Code never
 * reports an `Edit` on a path that no longer exists, and a hook that formats
 * or lints `file_path` would fail on one.
 */
export function patchFiles(patchText: string): string[] {
  const files = new Set<string>();
  /** The file of the latest `Update File`, which a `Move to` renames. */
  let updated: string | undefined;
  for (const line of patchText.split("\n")) {
    const [, header, path] = line.match(PATCH_FILE) ?? [];
    if (!path) continue;
    if (header === "Delete File") {
      files.delete(path);
    } else if (header === "Move to") {
      if (updated !== undefined) files.delete(updated);
      files.add(path);
    } else {
      files.add(path);
    }
    updated = header === "Update File" ? path : undefined;
  }
  return [...files];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Drops the keys whose value is undefined, so the JSON carries only what the call had. */
const defined = (input: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

/** Quotes a path for `sh`, so spaces and quotes in it survive. */
const shellQuote = (path: string): string => `'${path.replaceAll("'", `'\\''`)}'`;

/**
 * The command as a Claude Code agent would have written it.
 *
 * opencode runs a shell call in its `workdir` argument. Claude Code's `Bash`
 * has none, so an agent there writes `cd <dir> && <command>`, and hooks read
 * the directory from the command text: a provenance recorder checks every
 * repository a command names. Without the prefix, a call that edits another
 * repository through `workdir` names no repository at all. A `workdir` equal to
 * the project directory adds nothing, so the command is left as it is.
 */
function inWorkdir(command: unknown, workdir: unknown, directory: string): unknown {
  if (typeof command !== "string" || typeof workdir !== "string" || workdir === "") return command;
  const target = resolve(directory, workdir);
  return target === resolve(directory) ? command : `cd ${shellQuote(target)} && ${command}`;
}

/**
 * Maps one opencode tool call onto the Claude Code calls it amounts to.
 *
 * | opencode V1   | opencode V2 | Claude Code                           |
 * | ------------- | ----------- | ------------------------------------- |
 * | `write`       | `write`     | `Write`                               |
 * | `edit`        | `edit`      | `Edit`                                |
 * | `bash`        | `shell`     | `Bash`                                |
 * | `apply_patch` | `patch`     | one `Edit` per file the patch leaves  |
 *
 * The generations differ in arguments too: V1 names the file `filePath`, V2
 * `path`; V2's `shell` takes `background` where Claude Code's `Bash` takes
 * `run_in_background`. Both are read, so one mapping serves either. A shell
 * call's `workdir` becomes a `cd` in front of the command, as Claude Code's
 * `Bash` has no such argument.
 *
 * The patch tools have no Claude Code twin. Splitting one into an `Edit` per
 * file keeps the payload exact: a hook gets a real `file_path` instead of a
 * patch it would have to parse. Anything else maps to nothing.
 *
 * File paths are made absolute against `directory`, as Claude Code always
 * sends them: opencode accepts relative ones, and a hook running elsewhere
 * would otherwise resolve them against the wrong place. A `write` or `edit`
 * without a file path maps to nothing, since every hook on them acts on it.
 */
export function toClaudeToolCalls(tool: string, args: unknown, directory: string): ClaudeToolCall[] {
  const input = asRecord(args);
  const file = (path: unknown) => (typeof path === "string" && path !== "" ? resolve(directory, path) : undefined);
  switch (tool) {
    case "write": {
      const filePath = file(input.filePath ?? input.path);
      if (filePath === undefined) return [];
      return [{ tool_name: "Write", tool_input: defined({ file_path: filePath, content: input.content }) }];
    }
    case "edit": {
      const filePath = file(input.filePath ?? input.path);
      if (filePath === undefined) return [];
      return [
        {
          tool_name: "Edit",
          tool_input: defined({
            file_path: filePath,
            old_string: input.oldString,
            new_string: input.newString,
            replace_all: input.replaceAll,
          }),
        },
      ];
    }
    case "bash":
    case "shell":
      return [
        {
          tool_name: "Bash",
          tool_input: defined({
            command: inWorkdir(input.command, input.workdir, directory),
            description: input.description,
            timeout: input.timeout,
            run_in_background: input.background,
          }),
        },
      ];
    case "apply_patch":
    case "patch":
      return typeof input.patchText === "string"
        ? patchFiles(input.patchText).map((path) => ({ tool_name: "Edit", tool_input: { file_path: file(path) } }))
        : [];
    default:
      return [];
  }
}

/** Which opencode argument each Claude Code `tool_input` field came from, per tool. */
function argumentNames(tool: string, input: Record<string, unknown>): Record<string, string> | undefined {
  // V1 names the file `filePath`, V2 `path`: write back to the one the call used.
  const fileKey = input.filePath !== undefined ? "filePath" : "path";
  switch (tool) {
    case "write":
      return { file_path: fileKey, content: "content" };
    case "edit":
      return { file_path: fileKey, old_string: "oldString", new_string: "newString", replace_all: "replaceAll" };
    case "bash":
      return { command: "command", description: "description", timeout: "timeout" };
    case "shell":
      return { command: "command", description: "description", timeout: "timeout", run_in_background: "background" };
    default:
      return undefined;
  }
}

/** What `toOpencodeArgs` makes of an `updatedInput`. */
export type ArgumentChanges = {
  /** opencode arguments to overwrite, only those whose value changed. */
  args: Record<string, unknown>;
  /** `updatedInput` fields with no opencode argument to carry them. */
  ignored: string[];
};

/**
 * Maps a `PreToolUse` hook's `updatedInput` back onto the opencode arguments
 * of the call `toClaudeToolCalls` translated, the reverse of that mapping.
 *
 * Only the fields whose value differs from what the hook was sent are
 * returned, so a hook that echoes its whole `tool_input` back with one field
 * changed rewrites that field alone. A field the hook dropped is left as it
 * was: an argument cannot be safely removed on the hook's behalf.
 *
 * A shell call whose `workdir` reached the hook as a `cd` prefix keeps that
 * `workdir`; the prefix is stripped back off the new command when the hook
 * kept it, so the call does not `cd` twice.
 *
 * Returns undefined for a call that has no single opencode counterpart: a
 * patch reaches hooks as one `Edit` per file, and an edit to one of them
 * cannot be written back into the patch text.
 */
export function toOpencodeArgs(
  tool: string,
  args: unknown,
  call: ClaudeToolCall,
  updatedInput: Record<string, unknown>,
): ArgumentChanges | undefined {
  const input = asRecord(args);
  const names = argumentNames(tool, input);
  if (names === undefined) return undefined;

  const changes: ArgumentChanges = { args: {}, ignored: [] };
  for (const [field, value] of Object.entries(updatedInput)) {
    const name = names[field];
    if (name === undefined) {
      changes.ignored.push(field);
      continue;
    }
    if (JSON.stringify(value) === JSON.stringify(call.tool_input[field])) continue;
    changes.args[name] =
      field === "command" ? withoutWorkdirPrefix(value, call.tool_input.command, input.command) : value;
  }
  return changes;
}

/**
 * Removes the `cd '<workdir>' && ` that `inWorkdir` put in front of the
 * original command, when the hook's new command still starts with it.
 */
function withoutWorkdirPrefix(updated: unknown, sent: unknown, original: unknown): unknown {
  if (typeof updated !== "string" || typeof sent !== "string" || typeof original !== "string") return updated;
  if (sent === original || !sent.endsWith(original)) return updated;
  const prefix = sent.slice(0, sent.length - original.length);
  return updated.startsWith(prefix) ? updated.slice(prefix.length) : updated;
}
