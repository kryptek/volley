/**
 * A fleet of three machines and two repositories for the Repositories tests (SPEC §4.6.21):
 * `hub` (the supervisor's own), `box-a` and `box-b` (paired); `example-org/app` on every
 * machine, `example-org/lib` on box-a only. Each machine's verdict carries its `repos`.
 */
import type {
  ConfigPayload,
  MachinePayload,
  ReadinessPayload,
  RepoVerdict,
} from "../../src/store/types";

export const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

export const APP = "example-org/app";
export const LIB = "example-org/lib";

export function repoConfig(repos: ConfigPayload["repos"] = {}): ConfigPayload {
  return {
    version: 3,
    updated_at: iso(NOW),
    updated_by: "volleyd",
    fleet: { local_name: "hub" },
    hosts: { "box-a": { target: "you@box-a" }, "box-b": { target: "you@box-b" } },
    repos: { [APP]: { machines: "all" }, [LIB]: { machines: ["box-a"] }, ...repos },
  };
}

export function machine(name: string, over: Partial<MachinePayload> = {}): MachinePayload {
  return {
    name,
    os: "linux",
    cores: 8,
    tunnel: name === "hub" ? "local" : "up",
    load: [0.5, 0.5, 0.5],
    agents: 0,
    last_seen: iso(NOW - 10_000),
    ...over,
  };
}

export function verdict(
  name: string,
  repos: Record<string, RepoVerdict>,
  over: Partial<ReadinessPayload> = {},
): ReadinessPayload {
  return {
    name,
    ready: true,
    reasons: [],
    drain: false,
    max_agents: 4,
    placed: 0,
    path_ok: { claude: true, bun: true },
    requirements: { volley: "0.7.0" },
    heavy: {},
    usage: { account: null, five_hour_pct: null },
    eligible: true,
    checked_at: iso(NOW - 5000),
    repos,
    ...over,
  };
}

export const machines = (): Record<string, MachinePayload> => ({
  hub: machine("hub", {
    kind: "supervisor",
    repos: [
      {
        slug: APP,
        path: "/path/to/repos/example-org/app",
        exists: true,
        managed: true,
        fetched_at: iso(NOW - 60_000),
        toolchain: { ok: false, missing: ["java"], outdated: [] },
      },
    ],
  }),
  "box-a": machine("box-a", {
    repos: [
      {
        slug: APP,
        path: "/srv/work/app",
        exists: true,
        managed: false,
        fetched_at: iso(NOW - 60_000),
        toolchain: { ok: true, missing: [], outdated: [] },
      },
      {
        slug: LIB,
        path: "/path/to/home/.volley/repos/example-org/lib",
        exists: true,
        managed: true,
        fetched_at: iso(NOW - 60_000),
        toolchain: { ok: true, missing: [], outdated: [] },
      },
    ],
  }),
  "box-b": machine("box-b"),
});

export const readiness = (): Record<string, ReadinessPayload> => ({
  hub: verdict("hub", {
    [APP]: {
      state: "blocked",
      path: "/path/to/repos/example-org/app",
      reasons: [`java not installed (needed by ${APP})`, "repo.fetch: cannot fetch origin"],
    },
  }),
  "box-a": verdict("box-a", {
    [APP]: { state: "ready", path: "/srv/work/app", reasons: [] },
    [LIB]: { state: "ready", path: "/path/to/home/.volley/repos/example-org/lib", reasons: [] },
  }),
  "box-b": verdict("box-b", {
    [APP]: {
      state: "blocked",
      path: "/path/to/home/.volley/repos/example-org/app",
      reasons: ["box-b is down: retried when it is back"],
    },
  }),
});
