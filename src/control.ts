/**
 * Claude Code lets a hook command influence the agent by writing a JSON
 * directive to stdout, e.g.
 *
 *   { "continue": true, "systemMessage": "heads up" }
 *
 * Hook scripts routinely interleave that directive with ordinary log output on
 * the same stream, so the payload cannot be parsed as a single JSON document.
 */
export type Directive = {
  /** `false` asks the agent to stop. We honour it by skipping the remaining commands. */
  continue?: boolean;
  /** Text Claude Code surfaces to the model. Bridged into opencode's system prompt. */
  systemMessage?: string;
};

export type Control = {
  /** The last `systemMessage` seen, if any. */
  systemMessage?: string;
  /** True when a directive requested `continue: false`. */
  halt: boolean;
};

/**
 * Extracts the control directive from a command's stdout.
 *
 * Scans line by line rather than parsing the whole buffer, because a hook's
 * stdout is typically a mix of log lines and (optionally) one directive.
 * Lines that merely look like JSON are ignored rather than throwing.
 */
export function parseControl(stdout: string): Control {
  let systemMessage: string | undefined;
  let halt = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let directive: Directive;
    try {
      directive = JSON.parse(trimmed) as Directive;
    } catch {
      // Ordinary output that happens to start with "{" — not a directive.
      continue;
    }

    if (typeof directive.systemMessage === "string") systemMessage = directive.systemMessage;
    if (directive.continue === false) halt = true;
  }

  return { systemMessage, halt };
}
