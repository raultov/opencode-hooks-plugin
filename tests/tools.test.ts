import { describe, expect, test } from "bun:test";
import { patchFiles, toClaudeToolCalls } from "../src/tools.js";

const DIR = "/repo";

describe("toClaudeToolCalls", () => {
  test("maps write to Write with an absolute file_path", () => {
    expect(toClaudeToolCalls("write", { filePath: "src/a.ts", content: "x" }, DIR)).toEqual([
      { tool_name: "Write", tool_input: { file_path: "/repo/src/a.ts", content: "x" } },
    ]);
  });

  test("maps edit to Edit and keeps an absolute path as it is", () => {
    expect(toClaudeToolCalls("edit", { filePath: "/elsewhere/a.ts", oldString: "a", newString: "b" }, DIR)).toEqual([
      { tool_name: "Edit", tool_input: { file_path: "/elsewhere/a.ts", old_string: "a", new_string: "b" } },
    ]);
  });

  test("maps bash to Bash", () => {
    expect(toClaudeToolCalls("bash", { command: "ls", description: "list" }, DIR)).toEqual([
      { tool_name: "Bash", tool_input: { command: "ls", description: "list" } },
    ]);
  });

  test("splits apply_patch into one Edit per file", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "*** Move to: b.ts",
      "@@",
      "-x",
      "+y",
      "*** Update File: a.ts",
      "*** End Patch",
    ].join("\n");
    expect(toClaudeToolCalls("apply_patch", { patchText }, DIR)).toEqual([
      { tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } },
      { tool_name: "Edit", tool_input: { file_path: "/repo/b.ts" } },
    ]);
  });

  test("maps tools with no Claude Code counterpart to nothing", () => {
    expect(toClaudeToolCalls("read", { filePath: "a" }, DIR)).toEqual([]);
    expect(toClaudeToolCalls("apply_patch", {}, DIR)).toEqual([]);
    expect(toClaudeToolCalls("edit", null, DIR)).toEqual([{ tool_name: "Edit", tool_input: {} }]);
  });
});

describe("patchFiles", () => {
  test("ignores content lines that only look like headers", () => {
    expect(patchFiles("*** Add File: a\n+*** Add File: not-a-header")).toEqual(["a"]);
  });
});
