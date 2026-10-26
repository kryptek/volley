import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BugDeps, BugExecResult } from "../../src/bug/gather";

/**
 * A machine for `volley bug`: a real tmp home seeded by the test, an exec table keyed by the argv
 * joined with spaces (unknown: exit 127), and a file layer that records every path it reads.
 */
export interface BugMachine {
  deps: BugDeps;
  home: string;
  vhome: string;
  execs: Map<string, BugExecResult | "timeout">;
  calls: string[][];
  /** Answers an argv before the table (a prefix match, say); undefined: the table answers. */
  onExec?: (argv: string[]) => BugExecResult | undefined;
  reads: string[];
  write: (path: string, text: string, mtimeS?: number) => void;
}

export const BUG_NOW = new Date("2026-10-25T12:00:00Z");

export function bugMachine(home: string, over: Partial<BugDeps> = {}): BugMachine {
  const vhome = join(home, ".volley", "volleyd");
  mkdirSync(vhome, { recursive: true });
  const execs = new Map<string, BugExecResult | "timeout">();
  const calls: string[][] = [];
  const reads: string[] = [];
  const m: BugMachine = {
    home,
    vhome,
    execs,
    calls,
    reads,
    write: (path, text, mtimeS) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      if (mtimeS !== undefined) utimesSync(path, mtimeS, mtimeS);
    },
    deps: {
      exec: async (argv) => {
        calls.push(argv);
        const hooked = m.onExec?.(argv);
        if (hooked !== undefined) return hooked;
        const r = execs.get(argv.join(" "));
        if (r === "timeout") return { code: 124, stdout: "", stderr: "", timedOut: true };
        return r ?? { code: 127, stdout: "", stderr: `${argv[0]}: not found` };
      },
      home,
      env: { HOME: home, USER: "canaryuser", VOLLEYD_HOME: vhome },
      platform: "linux",
      arch: "x64",
      now: () => BUG_NOW,
      readFile: (path) => {
        reads.push(path);
        try {
          return readFileSync(path, "utf-8");
        } catch {
          return null;
        }
      },
      listDir: (path) => {
        try {
          return readdirSync(path);
        } catch {
          return null;
        }
      },
      mtimeMs: (path) => {
        try {
          return statSync(path).mtimeMs;
        } catch {
          return null;
        }
      },
      isTTY: false,
      hostname: () => "canary-host.example.lan",
      username: () => "canaryuser",
      cliDir: "/path/to/volley/packages/volley-cli/src",
      version: "0.13.2",
      volley: ["volley"],
      volleyd: ["volleyd"],
      ...over,
    },
  };
  return m;
}

export const ok = (stdout: string): BugExecResult => ({ code: 0, stdout, stderr: "" });
