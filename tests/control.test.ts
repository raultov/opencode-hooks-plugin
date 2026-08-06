import { describe, expect, test } from "bun:test";
import { parseControl } from "../src/control.js";

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
