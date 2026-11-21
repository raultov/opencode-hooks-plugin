import { resolve } from "node:path";
import { hooksFileCandidates, listCommands, readHooksFile } from "./hooks-file.js";
import { addApprovals, type CommandIdentity, defaultApprovalsFile, fingerprint, readApprovals } from "./trust.js";

/**
 * `opencode-hooks-plugin status|approve`: reviews and approves the commands of
 * a hooks file for `trust: "approved"`.
 *
 * It resolves the hooks file and `${CLAUDE_PLUGIN_ROOT}` the way the plugin
 * does, so the fingerprints it writes are the ones the plugin computes.
 */

export const USAGE = `Usage: opencode-hooks-plugin <status|approve> [options]

  status    List the bridged commands of a hooks file and whether each is approved
  approve   Approve them, for the plugin's trust: "approved" option

Options:
  --root <dir>             What \${CLAUDE_PLUGIN_ROOT} expands to, and where the hooks file is
                           probed (default: $OPENCODE_HOOKS_ROOT, else the current directory)
  --hooks-file <path>      Hooks file (default: $OPENCODE_HOOKS_FILE, else probed under the root)
  --approvals-file <path>  Approvals file (default: ~/.config/opencode-hooks/approved.json)
  --yes                    Approve without asking
`;

/** What the CLI talks to, injectable for tests. */
export type CliIO = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Asks a yes/no question; undefined when no one can answer it. */
  confirm: ((question: string) => Promise<boolean>) | undefined;
};

type Parsed = {
  command?: string;
  root?: string;
  hooksFile?: string;
  approvalsFile?: string;
  yes: boolean;
};

/** Parses `argv`, or returns the reason it cannot. */
function parse(argv: readonly string[]): Parsed | string {
  const parsed: Parsed = { yes: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = (): string | undefined => {
      index++;
      return argv[index];
    };
    switch (arg) {
      case "--root":
        parsed.root = value();
        if (parsed.root === undefined) return "--root needs a directory";
        break;
      case "--hooks-file":
        parsed.hooksFile = value();
        if (parsed.hooksFile === undefined) return "--hooks-file needs a path";
        break;
      case "--approvals-file":
        parsed.approvalsFile = value();
        if (parsed.approvalsFile === undefined) return "--approvals-file needs a path";
        break;
      case "--yes":
      case "-y":
        parsed.yes = true;
        break;
      default:
        if (arg === undefined || arg.startsWith("-") || parsed.command !== undefined)
          return `unexpected argument: ${arg}`;
        parsed.command = arg;
    }
  }
  return parsed;
}

/** Runs the CLI and returns its exit code. */
export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  const parsed = parse(argv);
  if (typeof parsed === "string" || (parsed.command !== "status" && parsed.command !== "approve")) {
    if (typeof parsed === "string") io.err(parsed);
    io.err(USAGE);
    return 2;
  }

  // Taken as given, as the plugin takes them: the placeholder expands to the
  // root exactly as written, and the fingerprint covers the expanded command.
  const root = parsed.root ?? io.env.OPENCODE_HOOKS_ROOT ?? io.cwd;
  const explicit = parsed.hooksFile ?? io.env.OPENCODE_HOOKS_FILE;
  const approvalsFile = resolve(io.cwd, parsed.approvalsFile ?? defaultApprovalsFile(io.env));

  let found: Awaited<ReturnType<typeof readHooksFile>>;
  try {
    found = await readHooksFile(
      hooksFileCandidates(resolve(io.cwd, root), explicit === undefined ? undefined : resolve(io.cwd, explicit)),
    );
  } catch (error) {
    io.err(`hooks file is not valid JSON: ${String(error)}`);
    return 1;
  }
  if (!found) {
    io.err(`no hooks file found under ${root}`);
    return 1;
  }

  let approved: Set<string>;
  try {
    approved = new Set(Object.keys((await readApprovals(approvalsFile)).approved));
  } catch (error) {
    io.err(`approvals file ${approvalsFile} is not valid JSON: ${String(error)}`);
    return 1;
  }

  const hooksFile = resolve(found.path);
  const entries = listCommands(found.file, root).map((entry) => {
    const identity: CommandIdentity = { hooksFile, event: entry.event, matcher: entry.matcher, command: entry.command };
    return { identity, id: fingerprint(identity), description: entry.description };
  });

  io.out(`Hooks file: ${hooksFile}`);
  io.out(`Approvals:  ${approvalsFile}`);
  if (entries.length === 0) {
    io.out("No bridged command hooks in this file.");
    return 0;
  }
  for (const { identity, id, description } of entries) {
    const state = approved.has(id) ? "approved" : "NOT APPROVED";
    const matcher = identity.matcher === "" ? "" : ` [${identity.matcher}]`;
    io.out("");
    io.out(`${state}  ${identity.event}${matcher}${description ? ` — ${description}` : ""}`);
    io.out(`  ${identity.command}`);
    io.out(`  ${id}`);
  }

  const pending = entries.filter(({ id }) => !approved.has(id));
  io.out("");
  if (pending.length === 0) {
    io.out("Every command is approved.");
    return 0;
  }
  if (parsed.command === "status") {
    io.out(`${pending.length} command(s) not approved.`);
    return 0;
  }

  if (!parsed.yes) {
    if (io.confirm === undefined) {
      io.err("Refusing to approve without a terminal to ask on. Review the list above and pass --yes.");
      return 1;
    }
    const answer = await io.confirm(
      `Approve ${pending.length} command(s)? They will run with your permissions when opencode starts in this project. [y/N] `,
    );
    if (!answer) {
      io.out("Nothing approved.");
      return 1;
    }
  }

  await addApprovals(
    approvalsFile,
    pending.map(({ identity }) => identity),
  );
  io.out(`Approved ${pending.length} command(s).`);
  return 0;
}
