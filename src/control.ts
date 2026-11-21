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

/** What a `PreToolUse` command decided about the call, read from its stdout. */
export type ToolDecision = {
  /** The most restrictive decision seen: `deny` over `ask` over `allow`. */
  decision?: "allow" | "deny" | "ask";
  /** Why, as the command put it alongside the winning decision. */
  reason?: string;
  /** Replacement for the call's Claude Code `tool_input`. The last one seen wins. */
  updatedInput?: Record<string, unknown>;
  /** Text for the model, every one seen in order. */
  additionalContext?: string;
};

const RANK = { allow: 1, ask: 2, deny: 3 } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The JSON objects a command printed. Claude Code parses the whole of stdout as
 * one document, so that is tried first, which also accepts a pretty-printed
 * object. Failing that, each line is tried on its own, as `parseControl` does,
 * because hook scripts interleave their directive with log output.
 */
function directives(stdout: string): Record<string, unknown>[] {
  const whole = stdout.trim();
  if (whole.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(whole);
      if (isRecord(parsed)) return [parsed];
    } catch {
      // Several lines, not one document: read them one by one below.
    }
  }
  return stdout.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return [];
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return isRecord(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Reads Claude Code's `PreToolUse` decision control from a command's stdout:
 * `hookSpecificOutput.permissionDecision` (`allow`, `deny`, `ask`) with its
 * `permissionDecisionReason`, `updatedInput` and `additionalContext`; the
 * deprecated top-level `decision` (`approve`, `block`) with `reason`, which
 * `hookSpecificOutput` overrides; and `continue: false`, which Claude Code
 * honours above everything else and is read here as a `deny` because of
 * `stopReason`.
 *
 * Fields of the wrong type are ignored rather than guessed at.
 */
export function parseToolDecision(stdout: string): ToolDecision {
  const result: ToolDecision = {};
  const contexts: string[] = [];

  const decide = (decision: "allow" | "deny" | "ask", reason: unknown) => {
    if (result.decision !== undefined && RANK[decision] < RANK[result.decision]) return;
    result.decision = decision;
    result.reason = typeof reason === "string" && reason.trim() !== "" ? reason : undefined;
  };

  for (const directive of directives(stdout)) {
    const specific = isRecord(directive.hookSpecificOutput) ? directive.hookSpecificOutput : {};
    const permission = specific.permissionDecision;

    if (permission === "allow" || permission === "deny" || permission === "ask") {
      decide(permission, specific.permissionDecisionReason);
    } else if (directive.decision === "block") {
      decide("deny", directive.reason);
    } else if (directive.decision === "approve") {
      decide("allow", directive.reason);
    }

    if (directive.continue === false) decide("deny", directive.stopReason);
    if (isRecord(specific.updatedInput)) result.updatedInput = specific.updatedInput;
    if (typeof specific.additionalContext === "string" && specific.additionalContext.trim() !== "") {
      contexts.push(specific.additionalContext);
    }
  }

  if (contexts.length > 0) result.additionalContext = contexts.join("\n");
  return result;
}
