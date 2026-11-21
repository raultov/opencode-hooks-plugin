import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Opt-in approval of the commands a project's own hooks file asks to run.
 *
 * Opening a repository that ships a `.claude/settings.json` would otherwise run
 * its commands, with the user's environment, the moment opencode starts. With
 * `trust: "approved"`, a command from a hooks file inside the project
 * directory runs only once its fingerprint has been approved, and approvals
 * live outside every repository, so a repository cannot approve itself.
 */

/** `all` runs every bridged command, as always. `approved` gates project hooks. */
export type TrustMode = "all" | "approved";

/** What a fingerprint is computed over: the behaviour of one bridged command. */
export type CommandIdentity = {
  /** The hooks file it was read from. Made absolute. */
  hooksFile: string;
  /** Claude Code event, e.g. `PreToolUse`. */
  event: string;
  /** Its group's matcher, `""` when there is none. */
  matcher: string;
  /** The shell line that runs, `${CLAUDE_PLUGIN_ROOT}` already expanded. */
  command: string;
};

/** One approval as stored, kept readable so the file can be audited by hand. */
export type Approval = CommandIdentity & { approvedAt: string };

/** The approvals file. */
export type Approvals = {
  version: 1;
  approved: Record<string, Approval>;
};

/** `$XDG_CONFIG_HOME/opencode-hooks/approved.json`, else under `~/.config`. */
export function defaultApprovalsFile(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== "" ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  return join(base, "opencode-hooks", "approved.json");
}

/**
 * Identifies a command by what it does: the file it came from, the event and
 * matcher that select it, and the command line. A `description` is cosmetic
 * and left out; widening a matcher or editing the command needs a new
 * approval. The content of a script the command calls is not covered.
 */
export function fingerprint(identity: CommandIdentity): string {
  const material = JSON.stringify([resolve(identity.hooksFile), identity.event, identity.matcher, identity.command]);
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

/**
 * Whether `path` lies inside `directory`, comparing the paths as written:
 * a hooks file reached through a link inside the project is still the
 * project's.
 */
export function isInside(path: string, directory: string): boolean {
  const relation = relative(resolve(directory), resolve(path));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keeps the stored approvals that have the expected shape, drops the rest. */
function parseApprovals(raw: string): Approvals {
  const parsed: unknown = JSON.parse(raw);
  const approved: Record<string, Approval> = {};
  if (isRecord(parsed) && isRecord(parsed.approved)) {
    for (const [key, value] of Object.entries(parsed.approved)) {
      if (
        isRecord(value) &&
        typeof value.hooksFile === "string" &&
        typeof value.event === "string" &&
        typeof value.matcher === "string" &&
        typeof value.command === "string"
      ) {
        approved[key] = {
          hooksFile: value.hooksFile,
          event: value.event,
          matcher: value.matcher,
          command: value.command,
          approvedAt: typeof value.approvedAt === "string" ? value.approvedAt : "",
        };
      }
    }
  }
  return { version: 1, approved };
}

/**
 * Reads the approvals file. A missing file approves nothing. A file that is not
 * valid JSON throws, so the caller can say so instead of silently treating
 * every approval as revoked.
 */
export async function readApprovals(path: string): Promise<Approvals> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { version: 1, approved: {} };
  }
  return parseApprovals(raw);
}

/**
 * Adds approvals to the file, keeping the ones already there. Written to a
 * temporary file and renamed into place, readable by the user alone.
 */
export async function addApprovals(
  path: string,
  identities: readonly CommandIdentity[],
  now = new Date(),
): Promise<Approvals> {
  const approvals = await readApprovals(path);
  for (const identity of identities) {
    approvals.approved[fingerprint(identity)] = {
      ...identity,
      hooksFile: resolve(identity.hooksFile),
      approvedAt: now.toISOString(),
    };
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(approvals, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  return approvals;
}
