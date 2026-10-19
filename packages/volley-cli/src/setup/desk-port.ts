import type { SetupExec } from "./step";

/**
 * Who listens on the Desk's port, on any address. A leftover server on 127.0.0.1:<port> beside the
 * Desk's own on 0.0.0.0:<port> answers http://localhost:<port> (the printed admin link) instead of
 * the Desk, so setup stops and names it.
 */

export interface PortListener {
  pid: number;
  /** The program's name as the OS reports it (`node`, `bun`, `python3`). */
  command: string;
  /** The address it listens on (`127.0.0.1:5199`, `*:5199`, `[::1]:5199`). */
  address: string;
}

/** The listeners in `lsof -F pcn` output (one record per process, one `n` line per socket). */
export function parseLsof(out: string): PortListener[] {
  const found: PortListener[] = [];
  let pid: number | null = null;
  let command = "";
  for (const line of out.split("\n")) {
    const [tag, value] = [line.slice(0, 1), line.slice(1)];
    if (tag === "p") {
      pid = Number(value);
      command = "";
    } else if (tag === "c") command = value;
    else if (tag === "n" && pid !== null && Number.isInteger(pid)) {
      found.push({ pid, command, address: value });
    }
  }
  return found;
}

/** The listeners in `ss -H -l -t -n -p` output (`users:(("node",pid=4242,fd=21))`). */
export function parseSs(out: string): PortListener[] {
  const found: PortListener[] = [];
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const address = cols[3];
    if (address === undefined) continue;
    for (const u of line.matchAll(/\("([^"]*)",pid=(\d+)/g)) {
      found.push({ pid: Number(u[2]), command: u[1] as string, address });
    }
  }
  return found;
}

export const lsofArgv = (port: number) => ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcn"];
export const ssArgv = (port: number) => [
  "ss",
  "-H",
  "-l",
  "-t",
  "-n",
  "-p",
  "sport",
  "=",
  `:${port}`,
];

/**
 * Every listener on `port` (lsof; `ss` where there is no lsof), or null when neither can tell
 * (not installed, or the exec refuses them: volleyd planning for the Desk).
 */
export async function deskPortListeners(
  exec: SetupExec,
  port: number,
): Promise<PortListener[] | null> {
  const run = (argv: string[]) => exec(argv).catch(() => null);
  const l = await run(lsofArgv(port));
  if (l !== null && l.code === 0) return parseLsof(l.stdout);
  // lsof exits 1, saying nothing, when nothing matches.
  if (l !== null && l.code === 1 && l.stdout.trim() === "") return [];
  const s = await run(ssArgv(port));
  if (s !== null && s.code === 0) return parseSs(s.stdout);
  return null;
}

/** Why setup stops: the other programs on the port, with what to do. */
export function portConflict(port: number, others: PortListener[]): string {
  const who = others.map((o) => `${o.command || "a program"} (PID ${o.pid}) on ${o.address}`);
  const pids = [...new Set(others.map((o) => o.pid))].join(" ");
  return `port ${port}, the Desk's, is taken by another program: ${who.join(", ")}. http://localhost:${port} would reach it instead of the Desk. Stop it (\`kill ${pids}\`) or give the Desk another port (\`volley setup --desk-port <n>\`), then rerun`;
}
