import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addApprovals, defaultApprovalsFile, fingerprint, isInside, readApprovals } from "../src/trust.js";

const identity = {
  hooksFile: "/repo/.claude/settings.json",
  event: "PreToolUse",
  matcher: "Bash",
  command: "guard.sh",
};

describe("fingerprint", () => {
  test("is stable for the same command", () => {
    expect(fingerprint(identity)).toBe(fingerprint({ ...identity }));
    expect(fingerprint(identity)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("changes with the command, the matcher, the event or the file", () => {
    const base = fingerprint(identity);
    expect(fingerprint({ ...identity, command: "guard.sh --off" })).not.toBe(base);
    expect(fingerprint({ ...identity, matcher: "*" })).not.toBe(base);
    expect(fingerprint({ ...identity, event: "PostToolUse" })).not.toBe(base);
    expect(fingerprint({ ...identity, hooksFile: "/other/.claude/settings.json" })).not.toBe(base);
  });
});

describe("isInside", () => {
  test("tells files inside the project from files outside it", () => {
    expect(isInside("/repo/.claude/settings.json", "/repo")).toBe(true);
    expect(isInside("/repo", "/repo")).toBe(true);
    expect(isInside("/repo-other/hooks.json", "/repo")).toBe(false);
    expect(isInside("/repo/../elsewhere/hooks.json", "/repo")).toBe(false);
  });

  test("does not mistake a sibling named ..something for the parent", () => {
    expect(isInside("/repo/..hidden/hooks.json", "/repo")).toBe(true);
  });
});

describe("defaultApprovalsFile", () => {
  test("lives under XDG_CONFIG_HOME when set", () => {
    expect(defaultApprovalsFile({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/opencode-hooks/approved.json");
  });

  test("falls back to ~/.config", () => {
    expect(defaultApprovalsFile({})).toMatch(/\.config\/opencode-hooks\/approved\.json$/);
  });
});

describe("approvals file", () => {
  test("a missing file approves nothing", async () => {
    expect(await readApprovals(join(tmpdir(), "definitely-absent-approvals.json"))).toEqual({
      version: 1,
      approved: {},
    });
  });

  test("a file that is not JSON throws instead of revoking everything quietly", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "trust-bad-")), "approved.json");
    await writeFile(path, "{ nope");
    await expect(readApprovals(path)).rejects.toThrow();
  });

  test("adds approvals, keeps earlier ones and is private to the user", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "trust-")), "nested", "approved.json");
    await addApprovals(path, [identity], new Date("2026-11-21T00:00:00Z"));
    const other = { ...identity, command: "other.sh" };
    await addApprovals(path, [other]);
    const approvals = await readApprovals(path);
    expect(Object.keys(approvals.approved).sort()).toEqual([fingerprint(identity), fingerprint(other)].sort());
    expect(approvals.approved[fingerprint(identity)]).toEqual({ ...identity, approvedAt: "2026-11-21T00:00:00.000Z" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });

  test("drops stored entries whose shape is wrong", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "trust-shape-")), "approved.json");
    await writeFile(path, JSON.stringify({ version: 1, approved: { a: { command: 1 }, b: "x" } }));
    expect((await readApprovals(path)).approved).toEqual({});
  });
});
