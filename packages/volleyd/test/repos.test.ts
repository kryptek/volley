import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type RepoConfig,
  SLUG_PATTERN,
  addPlan,
  assignedSlugs,
  cloneFor,
  homeFromClones,
  isSlug,
  legacyOrigin,
  managedClonePath,
  managedWorktreeRoot,
  originToSlug,
  pendingRepoRuns,
  repoStateLine,
  sameSlug,
  slugKey,
  unassignedSlugs,
  waveSlug,
  withMachines,
  withoutMachines,
} from "../src/repos";
import { SCHEMAS_DIR } from "../src/schemas";
import { schemaErrors } from "./helpers/schema";

const cfg = (over: Partial<RepoConfig> = {}): RepoConfig => ({
  repos: {},
  fleet: { repo_root: "~/.volley/repos" },
  hosts: {},
  ...over,
});

describe("repos: slugs (owner/name)", () => {
  it("accepts owner/name only", () => {
    for (const s of ["example-org/widgets", "Owner/Name", "a-b/c.d_e", "o/x.y-z"]) {
      expect(isSlug(s)).toBe(true);
    }
    for (const s of [
      "volley",
      "owner/name/extra",
      "https://github.com/o/r",
      "github.com/o/r",
      "git@github.com:o/r",
      "o/r.git",
      " o/r",
      "o/r ",
      "o /r",
      "o/",
      "/r",
      "-o/r",
      "o/..",
      "o/.",
    ]) {
      expect(isSlug(s), s).toBe(false);
    }
  });

  it("preserves case, compares case-insensitively", () => {
    expect(sameSlug("Owner/Name", "owner/name")).toBe(true);
    expect(sameSlug("owner/name", "owner/other")).toBe(false);
    expect(slugKey({ "Owner/Name": 1 }, "owner/NAME")).toBe("Owner/Name");
    expect(slugKey({ "a/b": 1 }, "a/c")).toBeUndefined();
  });

  it("the schema's slug patterns are this module's", () => {
    const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, "config.schema.json"), "utf-8"));
    const t = schema.$defs.tunableProperties.properties;
    expect(t.repos.propertyNames.pattern).toBe(SLUG_PATTERN);
    expect(schema.$defs.remoteHost.properties.repos.propertyNames.pattern).toBe(SLUG_PATTERN);
    // The machine record's repositories and per-repository checks (#435).
    const machine = readFileSync(join(SCHEMAS_DIR, "machine.schema.json"), "utf-8");
    const slugs = [...machine.matchAll(/"pattern": ("\^\[A-Za-z0-9\]\(\?:[^\n]*?\$")/g)].map((m) =>
      JSON.parse(m[1] as string),
    );
    expect(slugs).toEqual([SLUG_PATTERN, SLUG_PATTERN]);
  });

  it("the schema takes repos, fleet.repo_root and hosts.<m>.repos", () => {
    const ok = {
      repos: { "example-org/widgets": { machines: "all" }, "o/r": { machines: ["box", "mini"] } },
      fleet: { repo_root: "/srv/repos" },
      hosts: { box: { target: "dev@box", volley_dir: "/v", repos: { "o/r": "/src/r" } } },
    };
    expect(schemaErrors("config.schema.json#/$defs/tunables", ok)).toEqual([]);
    for (const bad of [
      { repos: { "o/r.git": { machines: "all" } } },
      { repos: { "o/r": { machines: "some" } } },
      { repos: { "o/r": { machines: ["Not A Host"] } } },
      { repos: { "o/r": {} } },
      { hosts: { box: { repos: { "o/r": "relative/path" } } } },
      { hosts: { box: { repos: { "https://x/o/r": "/p" } } } },
    ]) {
      expect(
        schemaErrors("config.schema.json#/$defs/tunables", bad),
        JSON.stringify(bad),
      ).not.toEqual([]);
    }
  });
});

describe("repos: originToSlug", () => {
  it("maps a normalised github.com origin to its slug", () => {
    expect(originToSlug("github.com/Owner/Name")).toBe("Owner/Name");
    expect(originToSlug("github.com/example-org/widgets")).toBe("example-org/widgets");
  });

  it("is undefined for any other origin", () => {
    expect(originToSlug("gitlab.example/x/y")).toBeUndefined();
    expect(originToSlug("github.com/o")).toBeUndefined();
    expect(originToSlug("github.com/o/r/extra")).toBeUndefined();
    expect(originToSlug("https://github.com/o/r")).toBeUndefined();
    expect(originToSlug(undefined)).toBeUndefined();
    expect(originToSlug(null)).toBeUndefined();
  });
});

describe("repos: a machine's home from its managed clones (#436)", () => {
  const clone = (slug: string, path: string, managed = true) => ({ slug, path, managed });
  it("strips the managed clone's <repo_root>/<owner>/<name> off its reported path", () => {
    expect(
      homeFromClones("~/.volley/repos", [clone("a/a", "/path/to/home/.volley/repos/a/a")]),
    ).toBe("/path/to/home");
    expect(homeFromClones("~", [clone("a/a", "/path/to/home/a/a")])).toBe("/path/to/home");
  });
  it("nothing to derive: an absolute repo_root, an adopted clone, a path that does not fit, none", () => {
    expect(homeFromClones("/srv/repos", [clone("a/a", "/srv/repos/a/a")])).toBeUndefined();
    expect(
      homeFromClones("~/.volley/repos", [clone("a/a", "/path/to/home/.volley/repos/a/a", false)]),
    ).toBeUndefined();
    expect(homeFromClones("~/.volley/repos", [clone("a/a", "/elsewhere/a/a")])).toBeUndefined();
    expect(homeFromClones("~/.volley/repos", undefined)).toBeUndefined();
  });
});

describe("repos: managed paths", () => {
  it("clones under repo_root/<owner>/<name>, expanded against the machine's home", () => {
    expect(managedClonePath("/srv/repos", "o/r")).toBe("/srv/repos/o/r");
    expect(managedClonePath("~/.volley/repos", "o/r", "/path/to/home")).toBe(
      "/path/to/home/.volley/repos/o/r",
    );
    // No home known: the path keeps its `~` (never absolute, so a resolver refuses it).
    expect(managedClonePath("~/.volley/repos", "o/r")).toBe("~/.volley/repos/o/r");
  });

  it("roots worktrees at <home>/.volley/worktrees/<owner>/<name>", () => {
    expect(managedWorktreeRoot("/path/to/home", "Owner/Name")).toBe(
      "/path/to/home/.volley/worktrees/Owner/Name",
    );
    expect(managedWorktreeRoot(undefined, "o/r")).toBe("~/.volley/worktrees/o/r");
  });
});

describe("repos: cloneFor precedence", () => {
  const home = "/path/to/home";

  it("an adopted clone (hosts.<m>.repos) wins", () => {
    const c = cfg({
      repos: { "o/r": { machines: "all" } },
      hosts: { box: { repo: "/legacy", repos: { "O/R": "/adopted/r" } } },
    });
    expect(cloneFor(c, "box", "o/r", { home, origin: "github.com/o/r" })).toBe("/adopted/r");
  });

  it("then the managed path, when repos.<slug>.machines includes the machine", () => {
    const listed = cfg({ repos: { "o/r": { machines: ["box"] } } });
    expect(cloneFor(listed, "box", "o/r", { home })).toBe("/path/to/home/.volley/repos/o/r");
    expect(cloneFor(listed, "mini", "o/r", { home })).toBeUndefined();
    const all = cfg({ repos: { "O/r": { machines: "all" } } });
    // Spelled as the config spells it: paths on disk are case-sensitive.
    expect(cloneFor(all, "mini", "o/R", { home })).toBe("/path/to/home/.volley/repos/O/r");
  });

  it("then a legacy hosts.<m>.repo, unless the record's origin is another repository", () => {
    const c = cfg({ hosts: { box: { repo: "/src/r" } } });
    expect(cloneFor(c, "box", "o/r", { origin: "github.com/O/R" })).toBe("/src/r");
    expect(cloneFor(c, "box", "o/r", { origin: "github.com/o/other" })).toBeUndefined();
    expect(cloneFor(c, "box", "o/r", { origin: "gitlab.example/o/r" })).toBeUndefined();
    // No origin reported yet: nothing says the clone is another repository's.
    expect(cloneFor(c, "box", "o/r", {})).toBe("/src/r");
    expect(cloneFor(c, "box", "o/r", { origin: null })).toBe("/src/r");
  });

  it("is undefined for a machine with none of them", () => {
    expect(cloneFor(cfg(), "box", "o/r", { home })).toBeUndefined();
  });
});

describe("repos: legacyOrigin", () => {
  it("is the record's origin only when its clone is the host's legacy repo", () => {
    const seen = { path: "/src/r/", origin: "github.com/o/r" };
    expect(legacyOrigin(seen, "/src/r")).toBe("github.com/o/r");
    expect(legacyOrigin({ path: "/src/r" }, "/src/r/")).toBeUndefined();
    // Another clone's origin says nothing about the legacy one.
    expect(legacyOrigin(seen, "/src/other")).toBeUndefined();
    expect(legacyOrigin(seen, undefined)).toBeUndefined();
    expect(legacyOrigin(undefined, "/src/r")).toBeUndefined();
  });
});

describe("repos: assignedSlugs", () => {
  it("lists the slugs assigned to a machine (all, a list, or an adopted clone)", () => {
    const c = cfg({
      repos: {
        "o/all": { machines: "all" },
        "o/listed": { machines: ["box"] },
        "o/other": { machines: ["mini"] },
      },
      hosts: { box: { repos: { "o/adopted": "/a" } } },
    });
    expect(assignedSlugs(c, "box")).toEqual(["o/adopted", "o/all", "o/listed"]);
    expect(assignedSlugs(c, "mini")).toEqual(["o/all", "o/other"]);
    expect(assignedSlugs(cfg(), "box")).toEqual([]);
  });

  it("unassignedSlugs: configured slugs given to other machines only, any spelling (#439)", () => {
    const c = cfg({
      repos: { "o/all": { machines: "all" }, "o/other": { machines: ["mini"] } },
      hosts: { box: { repos: { "o/adopted": "/a" } } },
    });
    expect(unassignedSlugs(c, "box", ["O/Other", "o/all", "o/adopted", "o/unknown"])).toEqual([
      "O/Other",
    ]);
    expect(unassignedSlugs(c, "mini", ["o/other", "o/adopted"])).toEqual(["o/adopted"]);
  });

  it("names an adopted clone of an assigned slug once", () => {
    const c = cfg({
      repos: { "o/r": { machines: "all" } },
      hosts: { box: { repos: { "O/R": "/a" } } },
    });
    expect(assignedSlugs(c, "box")).toEqual(["o/r"]);
  });
});

describe("repos: waveSlug", () => {
  it("is the wave state's github slug", () => {
    expect(
      waveSlug({ state: { github: { slug: "o/r", url: "https://github.com/o/r" } } }, "x"),
    ).toBe("o/r");
  });

  it("falls back to the supervisor clone's origin when gh could not be read", () => {
    expect(waveSlug({ state: {} }, "github.com/O/R")).toBe("O/R");
    expect(waveSlug({ state: null }, "gitlab.example/o/r")).toBeUndefined();
    expect(waveSlug({}, null)).toBeUndefined();
  });
});

describe("repos: repo_add / repo_remove assignments (SPEC §4.6.21)", () => {
  it("withMachines: all absorbs a list; lists merge once", () => {
    expect(withMachines(undefined, ["box"])).toEqual(["box"]);
    expect(withMachines(["box"], ["box", "b2"])).toEqual(["box", "b2"]);
    expect(withMachines(["box"], "all")).toBe("all");
    expect(withMachines("all", ["box"])).toBe("all");
  });

  it("withoutMachines: all spelled out as every machine; null once none is left", () => {
    expect(withoutMachines("all", ["box"], ["control", "box"])).toEqual(["control"]);
    expect(withoutMachines(["box"], ["box"], ["control", "box"])).toBeNull();
    expect(withoutMachines(["box", "b2"], "all", ["control"])).toBeNull();
    expect(withoutMachines(undefined, ["box"], ["control"])).toBeNull();
  });

  it("addPlan: managed or adopted, clone while none is reported, trust in the default and every signed-in profile there", () => {
    const c = cfg({
      repos: { "a/a": { machines: "all" } },
      hosts: { box: { repos: { "a/a": "/srv/mine" } }, b2: {} },
    });
    const accounts = [
      { id: "work", machine: "box", dir: "/h/.volley/claude/work", signed_in_at: "t" },
      { id: "new", machine: "box", dir: "/h/.volley/claude/new" },
      { id: "home", machine: "local", signed_in_at: "t" },
    ];
    const records = (m: string) =>
      m === "b2"
        ? {
            repos: [
              {
                slug: "a/a",
                path: "/b2/.volley/repos/a/a",
                exists: true,
                managed: true,
              },
            ],
          }
        : undefined;
    const steps = addPlan(c, "control", accounts, records, "A/a", ["control", "box", "b2"], {
      localHome: "/me",
      localDir: (id) => `/me/.volley/claude/${id}`,
    });
    expect(steps).toEqual([
      {
        machine: "control",
        local: true,
        repo_add: "a/a",
        path: "/me/.volley/repos/a/a",
        clone: true,
        profiles: [null, "/me/.volley/claude/home"],
      },
      {
        machine: "box",
        local: false,
        repo_add: "a/a=/srv/mine",
        path: "/srv/mine",
        clone: true,
        profiles: [null, "/h/.volley/claude/work"],
      },
      {
        machine: "b2",
        local: false,
        repo_add: "a/a",
        path: "/b2/.volley/repos/a/a",
        clone: false,
        profiles: [null],
      },
    ]);
  });

  it("pendingRepoRuns: a failed run stays pending until one succeeds or the repository is removed there", () => {
    const run = (machine: string, ok: boolean, error?: string) => ({
      type: "repo_clone_run",
      data: { machine, slug: "a/a", ok, ...(error !== undefined ? { error } : {}) },
    });
    expect(
      [...pendingRepoRuns([run("box", false, "ssh failed"), run("b2", false, "down")])].map(
        ([m, s]) => [m, [...s]],
      ),
    ).toEqual([
      ["box", [["a/a", "ssh failed"]]],
      ["b2", [["a/a", "down"]]],
    ]);
    expect(pendingRepoRuns([run("box", false, "x"), run("box", true)]).size).toBe(0);
    expect(
      pendingRepoRuns([
        run("box", false, "x"),
        { type: "repo_removed", data: { slug: "A/a", machines: ["box"] } },
      ]).size,
    ).toBe(0);
  });

  it("repoStateLine: one line per machine, its reasons or its path", () => {
    expect(repoStateLine("box", { state: "ready", path: "/srv/a", reasons: [] })).toBe(
      "box: ready (/srv/a)",
    );
    expect(repoStateLine("box", { state: "blocked", reasons: ["ssh failed", "x"] })).toBe(
      "box: blocked (ssh failed; x)",
    );
    expect(repoStateLine("box", { state: "cloning", reasons: [] })).toBe("box: cloning");
    expect(repoStateLine("box", undefined)).toBe("box: not assigned");
  });
});
