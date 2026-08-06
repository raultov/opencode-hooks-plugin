import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MATCHERS,
  type HooksFile,
  hooksFileCandidates,
  PLUGIN_ROOT_PLACEHOLDER as PH,
  readHooksFile,
  resolveCommands,
} from "../src/hooks-file.js";

const ROOT = "/opt/toolkit";

const fixture: HooksFile = {
  hooks: {
    SessionStart: [
      {
        matcher: "startup",
        hooks: [
          { type: "command", command: `"${PH}/hooks/memory.sh"`, description: "memory" },
          { type: "command", command: `"${PH}/hooks/deps.sh" "${PH}"` },
          { type: "prompt", command: "ignored because it is not a command" },
          { type: "command" },
        ],
      },
      {
        matcher: "clear",
        hooks: [{ type: "command", command: "should-not-run" }],
      },
      {
        hooks: [{ type: "command", command: "no-matcher-runs" }],
      },
    ],
    PreToolUse: [{ hooks: [{ type: "command", command: "other-event" }] }],
  },
};

describe("resolveCommands", () => {
  const resolve = (skip: string[] = []) => resolveCommands(fixture, "SessionStart", ROOT, DEFAULT_MATCHERS, skip);

  test("expands the plugin-root placeholder everywhere it appears", () => {
    expect(resolve()[1]?.command).toBe(`"${ROOT}/hooks/deps.sh" "${ROOT}"`);
  });

  test("keeps the declared order", () => {
    expect(resolve().map((entry) => entry.command)).toEqual([
      `"${ROOT}/hooks/memory.sh"`,
      `"${ROOT}/hooks/deps.sh" "${ROOT}"`,
      "no-matcher-runs",
    ]);
  });

  test("preserves descriptions", () => {
    expect(resolve()[0]?.description).toBe("memory");
  });

  test("drops entries whose matcher is not honoured", () => {
    expect(resolve().some((entry) => entry.command === "should-not-run")).toBe(false);
  });

  test("includes entries with no matcher", () => {
    expect(resolve().some((entry) => entry.command === "no-matcher-runs")).toBe(true);
  });

  test("drops non-command and command-less entries", () => {
    expect(resolve()).toHaveLength(3);
  });

  test("does not leak commands from other events", () => {
    expect(resolve().some((entry) => entry.command === "other-event")).toBe(false);
  });

  test("applies the skip list by substring", () => {
    expect(resolve(["memory.sh"]).map((entry) => entry.command)).toEqual([
      `"${ROOT}/hooks/deps.sh" "${ROOT}"`,
      "no-matcher-runs",
    ]);
  });

  test("returns nothing for an unknown event", () => {
    expect(resolveCommands(fixture, "Nope", ROOT, DEFAULT_MATCHERS, [])).toEqual([]);
  });

  test("returns nothing for a file with no hooks", () => {
    expect(resolveCommands({}, "SessionStart", ROOT, DEFAULT_MATCHERS, [])).toEqual([]);
  });
});

describe("hooksFileCandidates", () => {
  test("an explicit path wins outright", () => {
    expect(hooksFileCandidates(ROOT, "/tmp/custom.json")).toEqual(["/tmp/custom.json"]);
  });

  test("probes the plugin file before the settings file", () => {
    expect(hooksFileCandidates(ROOT)).toEqual([`${ROOT}/hooks/hooks.json`, `${ROOT}/.claude/settings.json`]);
  });
});

describe("readHooksFile", () => {
  test("returns undefined when no candidate exists", async () => {
    expect(await readHooksFile([join(tmpdir(), "definitely-absent-hooks.json")])).toBeUndefined();
  });

  test("reads the first existing candidate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooks-file-"));
    await mkdir(join(dir, ".claude"), { recursive: true });
    const settings = join(dir, ".claude", "settings.json");
    await writeFile(settings, JSON.stringify(fixture));

    const found = await readHooksFile([join(dir, "hooks", "hooks.json"), settings]);
    expect(found?.path).toBe(settings);
    expect(found?.file.hooks?.SessionStart).toHaveLength(3);
  });

  test("propagates a parse error for malformed JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooks-file-bad-"));
    const broken = join(dir, "hooks.json");
    await writeFile(broken, "{ not json");
    await expect(readHooksFile([broken])).rejects.toThrow();
  });
});
