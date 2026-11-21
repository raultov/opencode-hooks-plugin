import { describe, expect, test } from "bun:test";
import { patchFiles, toClaudeToolCalls, toOpencodeArgs } from "../src/tools.js";

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

  test("writes a shell call's workdir as a cd in front of the command", () => {
    expect(toClaudeToolCalls("shell", { command: "sed -i s/a/b/ f", workdir: "/other/it's" }, DIR)).toEqual([
      { tool_name: "Bash", tool_input: { command: `cd '/other/it'\\''s' && sed -i s/a/b/ f` } },
    ]);
  });

  test("resolves a relative workdir against the project directory", () => {
    expect(toClaudeToolCalls("bash", { command: "ls", workdir: "sub" }, DIR)).toEqual([
      { tool_name: "Bash", tool_input: { command: "cd '/repo/sub' && ls" } },
    ]);
  });

  test("leaves the command alone when workdir is the project directory", () => {
    expect(toClaudeToolCalls("shell", { command: "ls", workdir: "/repo/" }, DIR)).toEqual([
      { tool_name: "Bash", tool_input: { command: "ls" } },
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

describe("toOpencodeArgs", () => {
  /** Translates a call, then maps a hook's updatedInput back onto it. */
  const roundTrip = (tool: string, args: Record<string, unknown>, update: (input: Record<string, unknown>) => void) => {
    const [call] = toClaudeToolCalls(tool, args, DIR);
    if (call === undefined) throw new Error("no call");
    const updatedInput = { ...call.tool_input };
    update(updatedInput);
    return toOpencodeArgs(tool, args, call, updatedInput);
  };

  test("returns only the fields the hook changed, under V1's names", () => {
    const changes = roundTrip("edit", { filePath: "a.ts", oldString: "x", newString: "y" }, (input) => {
      input.new_string = "z";
    });
    expect(changes).toEqual({ args: { newString: "z" }, ignored: [] });
  });

  test("writes a new file_path back to V2's path argument", () => {
    const changes = roundTrip("write", { path: "a.ts", content: "x" }, (input) => {
      input.file_path = "/repo/b.ts";
    });
    expect(changes).toEqual({ args: { path: "/repo/b.ts" }, ignored: [] });
  });

  test("maps run_in_background back to V2's background", () => {
    const changes = roundTrip("shell", { command: "ls" }, (input) => {
      input.run_in_background = true;
    });
    expect(changes).toEqual({ args: { background: true }, ignored: [] });
  });

  test("strips the workdir cd the hook kept, so the call does not cd twice", () => {
    const changes = roundTrip("bash", { command: "rm x", workdir: "/other" }, (input) => {
      input.command = `${String(input.command)} -i`;
    });
    expect(changes).toEqual({ args: { command: "rm x -i" }, ignored: [] });
  });

  test("keeps a command the hook rewrote without the workdir cd as it is", () => {
    const changes = roundTrip("bash", { command: "rm x", workdir: "/other" }, (input) => {
      input.command = "echo safe";
    });
    expect(changes).toEqual({ args: { command: "echo safe" }, ignored: [] });
  });

  test("reports fields with no opencode argument", () => {
    const changes = roundTrip("bash", { command: "ls" }, (input) => {
      input.sandbox = true;
    });
    expect(changes).toEqual({ args: {}, ignored: ["sandbox"] });
  });

  test("has nothing to write back to a patch", () => {
    const patchText = "*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch";
    const [call] = toClaudeToolCalls("apply_patch", { patchText }, DIR);
    if (call === undefined) throw new Error("no call");
    expect(toOpencodeArgs("apply_patch", { patchText }, call, { file_path: "/repo/b.ts" })).toBeUndefined();
  });
});
