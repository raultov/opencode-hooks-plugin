import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A single Claude Code hook entry. Only `type: "command"` entries are bridged. */
export type HookEntry = {
  type?: string;
  command?: string;
  description?: string;
};

/** A matcher group inside an event's hook list. */
export type MatcherGroup = {
  matcher?: string;
  hooks?: HookEntry[];
};

/**
 * The shape both `hooks/hooks.json` (Claude Code plugins) and
 * `.claude/settings.json` (user/project settings) share.
 */
export type HooksFile = {
  hooks?: Record<string, MatcherGroup[]>;
};

/** A bridged command: shell line plus the description from the hooks file. */
export type ResolvedCommand = {
  command: string;
  description?: string;
};

/**
 * The literal token Claude Code expands to a plugin's install directory.
 * It is a Claude Code placeholder, not a JavaScript template.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal Claude Code token, not a JS template.
export const PLUGIN_ROOT_PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";

/** Relative locations probed when no explicit hooks file is configured. */
export const DEFAULT_HOOKS_FILES = ["hooks/hooks.json", ".claude/settings.json"] as const;

/** SessionStart matchers honoured by default. An entry with no matcher always runs. */
export const DEFAULT_MATCHERS = ["startup", "resume", ""] as const;

/**
 * Reads the first readable candidate and returns its parsed contents.
 * Returns `undefined` when none exists, so callers can no-op quietly.
 */
export async function readHooksFile(candidates: string[]): Promise<{ path: string; file: HooksFile } | undefined> {
  for (const path of candidates) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    return { path, file: JSON.parse(raw) as HooksFile };
  }
  return undefined;
}

/** Builds the candidate list: an explicit path wins, otherwise probe defaults under `root`. */
export function hooksFileCandidates(root: string, explicit?: string): string[] {
  if (explicit) return [explicit];
  return DEFAULT_HOOKS_FILES.map((relative) => join(root, relative));
}

/**
 * Skip entries that are empty or whitespace only.
 *
 * `"anything".includes("")` is true, so a single blank entry — a trailing comma
 * in the array, a config value that resolved to an empty string — would drop
 * every command and bridge nothing. Callers warn about what this finds.
 */
export function blankSkipNeedles(skip: readonly string[]): string[] {
  return skip.filter((needle) => needle.trim() === "");
}

/**
 * Selects the commands to run for an event and expands the plugin-root placeholder.
 *
 * @param file     parsed hooks file
 * @param event    Claude Code event name, e.g. `SessionStart`
 * @param root     value the plugin-root placeholder expands to
 * @param matchers matcher values to honour
 * @param skip     substrings; a command containing any of them is dropped.
 *                 Blank entries are ignored rather than matching everything.
 */
export function resolveCommands(
  file: HooksFile,
  event: string,
  root: string,
  matchers: readonly string[],
  skip: readonly string[],
): ResolvedCommand[] {
  const allowed = new Set(matchers);
  const needles = skip.filter((needle) => needle.trim() !== "");

  return (file.hooks?.[event] ?? [])
    .filter((group) => allowed.has(group.matcher ?? ""))
    .flatMap((group) => group.hooks ?? [])
    .flatMap((entry) => {
      if (entry.type !== "command" || typeof entry.command !== "string") return [];
      const command = entry.command.replaceAll(PLUGIN_ROOT_PLACEHOLDER, root);
      if (needles.some((needle) => command.includes(needle))) return [];
      return [{ command, description: entry.description }];
    });
}
