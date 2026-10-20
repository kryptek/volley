import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ApplyDeps, applyDeploy } from "../../src/deploy/apply";
import { type Ref, platformServices } from "../../src/deploy/plan";
import { DESK_STAMP, deskStamp } from "../../src/setup/desk-build";
import { fakeRepo } from "./fake-repo";

const services = platformServices("darwin", 501) ?? [];

function setup(o: Parameters<typeof fakeRepo>[0] & { from?: Ref }) {
  const f = fakeRepo({ tags: ["v0.4.0", "v0.5.0"], ...o });
  const lines: string[] = [];
  const health: { desk: (string | null)[]; volleyd: (string | null)[] } = { desk: [], volleyd: [] };
  const deskAnswers: (string | null)[] = [];
  const volleydAnswers: (string | null)[] = [];
  const deps: ApplyDeps = {
    exec: f.exec,
    env: { PATH: "/usr/bin", VITE_VOLLEY_BROKER_URL: "ws://leak:9001" },
    now: () => new Date("2026-10-20T14:05:09.000Z"),
    report: (l) => lines.push(l),
    deskHealthy: async (_base, version) => {
      health.desk.push(version);
      return deskAnswers.shift() ?? null;
    },
    volleydHealthy: async () => {
      health.volleyd.push(null);
      return volleydAnswers.shift() ?? null;
    },
  };
  const from: Ref = o.from ?? { kind: "tag", name: o.head.tag ?? "v0.4.0" };
  const run = (requested = "v0.5.0", stash?: string) =>
    applyDeploy(
      {
        repo: f.repo,
        bun: f.bun,
        services,
        deskPort: 5199,
        from,
        requested,
        ...(stash !== undefined ? { stash } : {}),
      },
      deps,
    );
  return { f, deps, lines, health, deskAnswers, volleydAnswers, run };
}

const checkout = (repo: string, ref: string) => `git -C ${repo} checkout --detach ${ref}`;

describe("applyDeploy", () => {
  it("runs the plan in order, stamps the Desk build, and reports each step", async () => {
    const { f, lines, health, run } = setup({ head: { tag: "v0.4.0" } });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.from).toBe("v0.4.0");
    expect(r.to).toBe("v0.5.0");
    expect(f.lines()).toEqual([
      `git -C ${f.repo} fetch --tags origin`,
      `git -C ${f.repo} tag --list v*`,
      checkout(f.repo, "v0.5.0"),
      `${f.bun} install --frozen-lockfile`,
      `${f.bun} run build`,
      `${f.bun} ${f.repo}/packages/volley-cli/src/cli.ts --version`,
      `${f.bun} ${f.repo}/packages/volleyd/src/cli.ts validate ${f.repo}/packages/volleyd/test/fixtures/example.yaml`,
      "launchctl kickstart -k gui/501/systems.volley.volleyd",
      "launchctl kickstart -k gui/501/systems.volley.desk",
    ]);
    expect(f.ran[3]?.cwd).toBe(f.repo);
    expect(f.ran[4]?.cwd).toBe(join(f.repo, "packages", "volley-desk"));
    expect(readFileSync(join(f.dist, DESK_STAMP), "utf-8")).toBe(`${deskStamp(f.repo)}\n`);
    expect(health.desk).toEqual(["0.5.0"]);
    expect(lines).toEqual([
      "ok      fetch tags",
      "ok      resolve v0.5.0",
      "ok      checkout v0.5.0 (detached)",
      "ok      bun install --frozen-lockfile",
      "ok      build the Desk",
      "ok      self-check",
      "ok      restart systems.volley.volleyd",
      "ok      restart systems.volley.desk",
      "ok      health-check",
    ]);
    expect(r.steps.every((s) => s.ok)).toBe(true);
  });

  it("builds the Desk without the developer's VITE_VOLLEY_BROKER_* in its env", async () => {
    const seen: (Record<string, string | undefined> | undefined)[] = [];
    const { f, deps, run } = setup({ head: { tag: "v0.4.0" } });
    const exec = deps.exec;
    deps.exec = (argv, o) => {
      if (argv[1] === "run") seen.push(o?.env);
      return exec(argv, o);
    };
    await run();
    expect(seen[0]?.PATH).toBe("/usr/bin");
    expect(seen[0]?.VITE_VOLLEY_BROKER_URL).toBeUndefined();
    void f;
  });

  it("--latest resolves after the fetch; --force-clean stashes first", async () => {
    const { f, lines, run } = setup({
      head: { tag: "v0.4.0" },
      tags: ["v0.4.0", "v0.5.0", "v0.6.0-rc.1", "v0.6.0"],
    });
    const r = await run("latest", "volley-deploy-2026-10-20T14-05-09Z");
    expect(r.to).toBe("v0.6.0");
    expect(f.lines()[0]).toBe(
      `git -C ${f.repo} stash push -u -m volley-deploy-2026-10-20T14-05-09Z`,
    );
    expect(lines[0]).toBe("ok      stash local changes as volley-deploy-2026-10-20T14-05-09Z");
    expect(f.state.stashes).toEqual(["volley-deploy-2026-10-20T14-05-09Z"]);
  });

  it("rolls back to the previous tag when a step after the checkout fails", async () => {
    const { f, lines, run } = setup({ head: { tag: "v0.4.0" } });
    f.fail(`${f.bun} install --frozen-lockfile`, "0.5.0", "error: lockfile had changes");
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual({
      step: "bun install --frozen-lockfile",
      why: "error: lockfile had changes",
    });
    expect(r.rolledBack).toBe(true);
    const after = f.lines().slice(f.lines().indexOf(`${f.bun} install --frozen-lockfile`) + 1);
    expect(after).toEqual([
      checkout(f.repo, "v0.4.0"),
      `${f.bun} install --frozen-lockfile`,
      `${f.bun} run build`,
      `${f.bun} ${f.repo}/packages/volley-cli/src/cli.ts --version`,
      `${f.bun} ${f.repo}/packages/volleyd/src/cli.ts validate ${f.repo}/packages/volleyd/test/fixtures/example.yaml`,
      "launchctl kickstart -k gui/501/systems.volley.volleyd",
      "launchctl kickstart -k gui/501/systems.volley.desk",
    ]);
    // A rollback never stashes or fetches.
    expect(after.some((l) => l.includes(" stash ") || l.includes(" fetch "))).toBe(false);
    expect(lines).toContain("FAILED  bun install --frozen-lockfile: error: lockfile had changes");
    expect(lines).toContain("rolling back to v0.4.0");
    expect(lines.at(-1)).toBe("ok      rollback: health-check");
    expect(f.versionAt()).toBe("0.4.0");
  });

  it("rolls back on a failed health check, to a release whose build wrote no version.json", async () => {
    const { f, health, deskAnswers, run } = setup({
      head: { tag: "v0.4.0" },
      noVersionJson: ["0.4.0"],
    });
    deskAnswers.push("the Desk serves 0.4.0, not 0.5.0");
    const r = await run();
    expect(r.failed?.step).toBe("health-check");
    expect(r.failed?.why).toContain("the Desk serves 0.4.0");
    expect(r.rolledBack).toBe(true);
    // The rollback takes the old bundle as it is.
    expect(health.desk).toEqual(["0.5.0", null]);
    expect(f.versionAt()).toBe("0.4.0");
  });

  it("fails the self-check when the checkout is not the tag's version", async () => {
    const { f, run } = setup({ head: { tag: "v0.4.0" } });
    const exec = f.exec;
    const r = await applyDeploy(
      {
        repo: f.repo,
        bun: f.bun,
        services,
        deskPort: 5199,
        from: { kind: "tag", name: "v0.4.0" },
        requested: "v0.5.0",
      },
      {
        exec: async (argv, o) =>
          argv[2] === "--version" && f.versionAt() === "0.5.0"
            ? { code: 0, stdout: "0.4.9\n", stderr: "" }
            : exec(argv, o),
        env: {},
        now: () => new Date(),
        report: () => {},
        deskHealthy: async () => null,
        volleydHealthy: async () => null,
      },
    );
    expect(r.failed).toEqual({
      step: "self-check",
      why: "volley --version is 0.4.9, not 0.5.0",
    });
    expect(r.rolledBack).toBe(true);
    void run;
  });

  it("checks a branch out again when the checkout was on one", async () => {
    const { f, run } = setup({
      head: { branch: "main" },
      from: { kind: "branch", name: "main" },
    });
    f.fail(`${f.bun} run build`, "0.5.0");
    const r = await run();
    expect(r.from).toBe("main");
    expect(r.rolledBack).toBe(true);
    expect(f.lines()).toContain(`git -C ${f.repo} checkout main`);
    expect(f.state.head).toEqual({ branch: "main" });
  });

  it("changes nothing and rolls nothing back when the fetch, the tag or the checkout fails", async () => {
    const a = setup({ head: { tag: "v0.4.0" } });
    a.f.fail(`git -C ${a.f.repo} fetch --tags origin`);
    const ra = await a.run();
    expect(ra.failed?.step).toBe("fetch tags");
    expect(ra.rolledBack).toBe(false);
    expect(a.f.lines()).toEqual([`git -C ${a.f.repo} fetch --tags origin`]);

    const b = setup({ head: { tag: "v0.4.0" } });
    const rb = await b.run("v9.9.9");
    expect(rb.failed).toEqual({
      step: "resolve v9.9.9",
      why: "no tag v9.9.9 (the newest are v0.5.0, v0.4.0)",
    });
    expect(rb.rolledBack).toBe(false);

    const c = setup({ head: { tag: "v0.4.0" } });
    c.f.fail(checkout(c.f.repo, "v0.5.0"));
    const rc = await c.run();
    expect(rc.failed?.step).toBe("checkout v0.5.0 (detached)");
    expect(rc.rolledBack).toBe(false);
    expect(c.f.lines().at(-1)).toBe(checkout(c.f.repo, "v0.5.0"));
  });

  it("returns the commands to run by hand when the rollback fails too", async () => {
    const { f, lines, run } = setup({ head: { tag: "v0.4.0" } });
    f.fail("launchctl kickstart -k gui/501/systems.volley.volleyd");
    const r = await run();
    expect(r.failed?.step).toBe("restart systems.volley.volleyd");
    expect(r.rolledBack).toBe(false);
    expect(r.rollbackFailed?.step).toBe("restart systems.volley.volleyd");
    expect(r.rollbackFailed?.byHand).toEqual([
      `git -C ${f.repo} checkout --detach v0.4.0`,
      `cd ${f.repo} && ${f.bun} install --frozen-lockfile`,
      `cd ${f.repo}/packages/volley-desk && ${f.bun} run build`,
      "launchctl kickstart -k gui/501/systems.volley.volleyd",
      "launchctl kickstart -k gui/501/systems.volley.desk",
    ]);
    expect(lines).toContain("FAILED  rollback: restart systems.volley.volleyd: launchctl failed");
  });
});
