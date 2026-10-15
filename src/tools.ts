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
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/;

/** The files an `apply_patch` call touches, in order, each once. */
export function patchFiles(patchText: string): string[] {
  const files = new Set<string>();
  for (const line of patchText.split("\n")) {
    const path = line.match(PATCH_FILE)?.[1];
    if (path) files.add(path);
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
 * | opencode      | Claude Code                                     |
 * | ------------- | ----------------------------------------------- |
 * | `write`       | `Write`                                         |
 * | `edit`        | `Edit`                                          |
 * | `bash`        | `Bash`                                          |
 * | `apply_patch` | one `Edit` per file the patch names             |
 *
 * `apply_patch` has no Claude Code twin. Splitting it into one `Edit` per file
 * keeps the payload exact: a hook gets a real `file_path` instead of a patch
 * it would have to parse. Anything else maps to nothing.
 *
 * File paths are made absolute against `directory`, as Claude Code always
 * sends them: opencode accepts relative ones, and a hook running elsewhere
 * would otherwise resolve them against the wrong place.
 */
export function toClaudeToolCalls(tool: string, args: unknown, directory: string): ClaudeToolCall[] {
  const input = asRecord(args);
  const file = (path: unknown) => (typeof path === "string" ? resolve(directory, path) : undefined);
  switch (tool) {
    case "write":
      return [{ tool_name: "Write", tool_input: defined({ file_path: file(input.filePath), content: input.content }) }];
    case "edit":
      return [
        {
          tool_name: "Edit",
          tool_input: defined({
            file_path: file(input.filePath),
            old_string: input.oldString,
            new_string: input.newString,
            replace_all: input.replaceAll,
          }),
        },
      ];
    case "bash":
      return [
        {
          tool_name: "Bash",
          tool_input: defined({ command: input.command, description: input.description, timeout: input.timeout }),
        },
      ];
    case "apply_patch":
      return typeof input.patchText === "string"
        ? patchFiles(input.patchText).map((path) => ({ tool_name: "Edit", tool_input: { file_path: file(path) } }))
        : [];
    default:
      return [];
  }
}
