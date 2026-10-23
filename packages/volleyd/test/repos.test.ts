import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type RepoConfig,
  SLUG_PATTERN,
  assignedSlugs,
  cloneFor,
  isSlug,
  managedClonePath,
  managedWorktreeRoot,
  originToSlug,
  sameSlug,
  slugKey,
  waveSlug,
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
    for (const s of ["kryptek/volley", "Owner/Name", "a-b/c.d_e", "o/x.y-z"]) {
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
  });

  it("the schema takes repos, fleet.repo_root and hosts.<m>.repos", () => {
    const ok = {
      repos: { "kryptek/volley": { machines: "all" }, "o/r": { machines: ["box", "mini"] } },
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
    expect(originToSlug("github.com/kryptek/volley")).toBe("kryptek/volley");
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
