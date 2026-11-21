import { describe, expect, test } from "bun:test";
import { parseControl, parseToolDecision } from "../src/control.js";

describe("parseControl", () => {
  test("returns no message and no halt for empty stdout", () => {
    expect(parseControl("")).toEqual({ systemMessage: undefined, halt: false });
  });

  test("ignores plain log output", () => {
    expect(parseControl("[install-deps] venv already exists\n[install-deps] Done")).toEqual({
      systemMessage: undefined,
      halt: false,
    });
  });

  test("extracts a directive interleaved with log lines", () => {
    const stdout = [
      "[fetch] already cached",
      '{ "continue": true, "systemMessage": "restart the CLI" }',
      "[fetch] done",
    ].join("\n");
    expect(parseControl(stdout)).toEqual({ systemMessage: "restart the CLI", halt: false });
  });

  test("ignores lines that look like JSON but are not", () => {
    expect(parseControl("{ not json at all")).toEqual({ systemMessage: undefined, halt: false });
  });

  test("keeps the last systemMessage when several are emitted", () => {
    const stdout = ['{ "systemMessage": "first" }', '{ "systemMessage": "second" }'].join("\n");
    expect(parseControl(stdout).systemMessage).toBe("second");
  });

  test("reports halt on continue:false", () => {
    expect(parseControl('{ "continue": false }').halt).toBe(true);
  });

  test("does not report halt on continue:true", () => {
    expect(parseControl('{ "continue": true }').halt).toBe(false);
  });

  test("tolerates indented directives", () => {
    expect(parseControl('   { "systemMessage": "indented" }  ').systemMessage).toBe("indented");
  });

  test("ignores a non-string systemMessage", () => {
    expect(parseControl('{ "systemMessage": 42 }').systemMessage).toBeUndefined();
  });
});

describe("parseToolDecision", () => {
  test("decides nothing for empty or plain output", () => {
    expect(parseToolDecision("")).toEqual({});
    expect(parseToolDecision("[guard] checked\n")).toEqual({});
  });

  test("reads a deny with its reason from hookSpecificOutput", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "rm -rf is not allowed",
      },
    });
    expect(parseToolDecision(stdout)).toEqual({ decision: "deny", reason: "rm -rf is not allowed" });
  });

  test("accepts a pretty-printed document, as Claude Code parses the whole of stdout", () => {
    const stdout = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } }, null, 2);
    expect(parseToolDecision(stdout).decision).toBe("deny");
  });

  test("finds a one-line directive among log lines", () => {
    const stdout = `[guard] start\n${JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } })}\n[guard] end`;
    expect(parseToolDecision(stdout).decision).toBe("allow");
  });

  test("keeps the most restrictive decision across directives", () => {
    const stdout = [
      JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "first" } }),
      JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow", permissionDecisionReason: "second" } }),
    ].join("\n");
    expect(parseToolDecision(stdout)).toEqual({ decision: "deny", reason: "first" });
  });

  test("reads the deprecated decision and reason, which hookSpecificOutput overrides", () => {
    expect(parseToolDecision(JSON.stringify({ decision: "block", reason: "legacy" }))).toEqual({
      decision: "deny",
      reason: "legacy",
    });
    expect(parseToolDecision(JSON.stringify({ decision: "approve" })).decision).toBe("allow");
    const both = JSON.stringify({ decision: "block", hookSpecificOutput: { permissionDecision: "allow" } });
    expect(parseToolDecision(both).decision).toBe("allow");
  });

  test("reads continue:false as a deny carrying its stopReason", () => {
    expect(parseToolDecision(JSON.stringify({ continue: false, stopReason: "stop here" }))).toEqual({
      decision: "deny",
      reason: "stop here",
    });
  });

  test("returns updatedInput and every additionalContext", () => {
    const stdout = [
      JSON.stringify({ hookSpecificOutput: { updatedInput: { command: "ls -la" }, additionalContext: "one" } }),
      JSON.stringify({ hookSpecificOutput: { additionalContext: "two" } }),
    ].join("\n");
    expect(parseToolDecision(stdout)).toEqual({ updatedInput: { command: "ls -la" }, additionalContext: "one\ntwo" });
  });

  test("ignores fields of the wrong type", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "nope", updatedInput: "ls", additionalContext: 3 },
    });
    expect(parseToolDecision(stdout)).toEqual({});
  });
});
