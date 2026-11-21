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
  /** Its group's matcher, `""` when the group has none. */
  matcher?: string;
};

/** The Claude Code events this plugin runs. */
export const BRIDGED_EVENTS = ["SessionStart", "PreToolUse", "PostToolUse"] as const;

/**
 * The literal token Claude Code expands to a plugin's install directory.
 * It is a Claude Code placeholder, not a JavaScript template.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal Claude Code token, not a JS template.
export const PLUGIN_ROOT_PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";

/** Relative locations probed when no explicit hooks file is configured. */
export const DEFAULT_HOOKS_FILES = ["hooks/hooks.json", ".claude/settings.json"] as const;

/**
 * SessionStart matchers honoured by default. A group with no matcher counts as
 * `""`, so it runs with these defaults, but not with a `matchers` list that
 * leaves `""` out.
 */
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

/** A bridged tool-event command, kept with the matcher that selects its tools. */
export type ToolCommand = ResolvedCommand & {
  matcher: string;
};

/**
 * Whether a tool-event matcher selects a Claude Code tool name.
 *
 * Follows Claude Code: an empty matcher or `*` selects every tool, anything
 * else is a regular expression that must match the whole name, so `Write|Edit`
 * selects both and `Edit` does not select `NotebookEdit`. A matcher that is not
 * a valid expression selects nothing.
 */
export function matchesTool(matcher: string, tool: string): boolean {
  if (matcher === "" || matcher === "*") return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return false;
  }
}

/**
 * Selects the commands of a tool event (`PreToolUse`, `PostToolUse`), keeping each one's
 * matcher, since which of them runs depends on the tool that was called.
 */
export function resolveToolCommands(
  file: HooksFile,
  event: string,
  root: string,
  skip: readonly string[],
): ToolCommand[] {
  return (file.hooks?.[event] ?? []).flatMap((group) =>
    resolveCommands({ hooks: { [event]: [{ hooks: group.hooks }] } }, event, root, [""], skip).map((command) => ({
      ...command,
      matcher: group.matcher ?? "",
    })),
  );
}

/**
 * Selects the commands to run for an event and expands the plugin-root placeholder.
 *
 * @param file     parsed hooks file
 * @param event    Claude Code event name, e.g. `SessionStart`
 * @param root     value the plugin-root placeholder expands to
 * @param matchers matcher values to honour. A group matcher such as
 *                 `startup|resume` is honoured when any alternative is.
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

  // Claude Code reads `startup|resume` as either source, so each alternative
  // is checked on its own. Its toolkit hooks files ship such groups.
  return (file.hooks?.[event] ?? [])
    .filter((group) => (group.matcher ?? "").split("|").some((value) => allowed.has(value)))
    .flatMap((group) => (group.hooks ?? []).map((entry) => ({ entry, matcher: group.matcher ?? "" })))
    .flatMap(({ entry, matcher }) => {
      if (entry.type !== "command" || typeof entry.command !== "string") return [];
      const command = entry.command.replaceAll(PLUGIN_ROOT_PLACEHOLDER, root);
      if (needles.some((needle) => command.includes(needle))) return [];
      return [{ command, description: entry.description, matcher }];
    });
}

/** One entry of a bridged event, as `listCommands` reports it. */
export type ListedCommand = {
  event: (typeof BRIDGED_EVENTS)[number];
  matcher: string;
  command: string;
  description?: string;
};

/**
 * Every `type: "command"` entry of the bridged events, placeholder expanded,
 * whatever its matcher: what `trust: "approved"` may be asked to run.
 */
export function listCommands(file: HooksFile, root: string): ListedCommand[] {
  return BRIDGED_EVENTS.flatMap((event) =>
    (file.hooks?.[event] ?? []).flatMap((group) =>
      (group.hooks ?? []).flatMap((entry) =>
        entry.type === "command" && typeof entry.command === "string"
          ? [
              {
                event,
                matcher: group.matcher ?? "",
                command: entry.command.replaceAll(PLUGIN_ROOT_PLACEHOLDER, root),
                description: entry.description,
              },
            ]
          : [],
      ),
    ),
  );
}

/**
 * What the hooks file declares that this plugin does not run, counted, e.g.
 * `["Stop: 2", "PreToolUse type prompt: 1"]`: events it does not bridge, and
 * entries of a bridged event that are not a `command` with a command line.
 * Tolerates a file whose shape is off, since it only feeds a log line.
 */
export function unsupportedHooks(file: HooksFile): string[] {
  const counts = new Map<string, number>();
  const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const bridged: readonly string[] = BRIDGED_EVENTS;

  for (const [event, groups] of Object.entries(file.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const entries = group?.hooks;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!bridged.includes(event)) {
          count(event);
        } else if (entry?.type !== "command") {
          count(`${event} type ${String(entry?.type ?? "missing")}`);
        } else if (typeof entry.command !== "string") {
          count(`${event} command missing`);
        }
      }
    }
  }
  return [...counts].map(([key, n]) => `${key}: ${n}`);
}
