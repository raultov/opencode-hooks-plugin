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

  test("splits apply_patch into one Edit per file it leaves on disk", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Add File: c.ts",
      "+z",
      "*** Update File: a.ts",
      "*** Move to: b.ts",
      "@@",
      "-x",
      "+y",
      "*** Delete File: d.ts",
      "*** Update File: e.ts",
      "*** End Patch",
    ].join("\n");
    expect(toClaudeToolCalls("apply_patch", { patchText }, DIR)).toEqual([
      { tool_name: "Edit", tool_input: { file_path: "/repo/c.ts" } },
      { tool_name: "Edit", tool_input: { file_path: "/repo/b.ts" } },
      { tool_name: "Edit", tool_input: { file_path: "/repo/e.ts" } },
    ]);
  });

  test("maps the V2 write and edit, which name the file `path`", () => {
    expect(toClaudeToolCalls("write", { path: "a.ts", content: "x" }, DIR)).toEqual([
      { tool_name: "Write", tool_input: { file_path: "/repo/a.ts", content: "x" } },
    ]);
    expect(
      toClaudeToolCalls("edit", { path: "/abs/a.ts", oldString: "a", newString: "b", replaceAll: true }, DIR),
    ).toEqual([
      {
        tool_name: "Edit",
        tool_input: { file_path: "/abs/a.ts", old_string: "a", new_string: "b", replace_all: true },
      },
    ]);
  });

  test("maps the V2 shell to Bash, background as run_in_background", () => {
    expect(toClaudeToolCalls("shell", { command: "ls", timeout: 5000, background: true }, DIR)).toEqual([
      { tool_name: "Bash", tool_input: { command: "ls", timeout: 5000, run_in_background: true } },
    ]);
  });

  test("maps the V2 patch like apply_patch", () => {
    expect(toClaudeToolCalls("patch", { patchText: "*** Add File: a.ts\n+x" }, DIR)).toEqual([
      { tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } },
    ]);
  });

  test("maps tools with no Claude Code counterpart to nothing", () => {
    expect(toClaudeToolCalls("read", { filePath: "a" }, DIR)).toEqual([]);
    expect(toClaudeToolCalls("apply_patch", {}, DIR)).toEqual([]);
  });

  test("maps a write or edit with no file path to nothing", () => {
    expect(toClaudeToolCalls("edit", null, DIR)).toEqual([]);
    expect(toClaudeToolCalls("edit", { oldString: "a", newString: "b" }, DIR)).toEqual([]);
    expect(toClaudeToolCalls("write", { content: "x" }, DIR)).toEqual([]);
    expect(toClaudeToolCalls("write", { filePath: 42, content: "x" }, DIR)).toEqual([]);
  });
});

describe("patchFiles", () => {
  test("ignores content lines that only look like headers", () => {
    expect(patchFiles("*** Add File: a\n+*** Add File: not-a-header")).toEqual(["a"]);
  });

  test("leaves out deleted files", () => {
    expect(patchFiles("*** Delete File: a\n*** Update File: b")).toEqual(["b"]);
  });

  test("keeps only the destination of a move", () => {
    expect(patchFiles("*** Update File: a\n*** Move to: b")).toEqual(["b"]);
  });

  test("leaves out a file the patch updates, then deletes", () => {
    expect(patchFiles("*** Update File: a\n*** Delete File: a")).toEqual([]);
  });

  test("keeps a file the patch deletes, then adds again", () => {
    expect(patchFiles("*** Delete File: a\n*** Add File: a\n+x")).toEqual(["a"]);
  });
});
