import { resolve } from "node:path";

/**
 * Translates opencode tool calls into the shape Claude Code hands its
 * `PostToolUse` hooks, so a hook written for Claude Code reads the same
 * `tool_name` and `tool_input` under opencode.
 *
 * Only the tools that change files are translated. A hook matched on any other
 * Claude Code tool has no opencode counterpart this plugin can vouch for, so it
 * is not run rather than run against a guessed payload.
 */

/** One Claude Code tool call, as a `PostToolUse` hook sees it. */
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
 * `run_in_background`. Both are read, so one mapping serves either.
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
            command: input.command,
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
