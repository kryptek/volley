import { describe, expect, it } from "vitest";
import type { MachineRecord } from "../src/machines";
import {
  type Candidate,
  type RepoFacts,
  admissionRefusals,
  closingLine,
  factsUnknown,
  lacksIdentity,
  machineBlock,
  readRepoCheck,
  readRepoFacts,
  repositoryChecks,
} from "../src/repo-check";
import { fakeExec } from "./helpers/fake-exec";

const SLUG = "example-org/widgets";
const B = "release/2026-10-26-x";
const api = (path: string) => ["gh", "api", `repos/${SLUG}/${path}`];
const VIEW = ["gh", "repo", "view", SLUG];

const view = {
  stdout: JSON.stringify({
    nameWithOwner: SLUG,
    url: `https://github.com/${SLUG}`,
    visibility: "PRIVATE",
  }),
};
const workflows = (n: number) => ({
  stdout: JSON.stringify({
    workflows: Array.from({ length: n }, (_, i) => ({ id: i, state: "active" })),
  }),
});
const notFound = { code: 1, stderr: "gh: Not Found (HTTP 404)\n" };

/** A repository GitHub knows, with `n` workflows and the release branch pushed, unprotected. */
function github(n = 3) {
  return fakeExec()
    .on(VIEW, view)
    .on(api("actions/workflows?per_page=100"), workflows(n))
    .on(api(`branches/${B}`), { stdout: JSON.stringify({ name: B, protected: false }) })
    .on(api(`rules/branches/${B}`), { stdout: "[]" });
}

describe("readRepoFacts", () => {
  it("a pushed, unprotected branch: exists, no checks, no reviews; every read through the fence", async () => {
    const fake = github();
    const f = await readRepoCheck(fake.exec, SLUG, B);
    expect(f).toMatchObject({
      branch_exists: true,
      required_reviews: 0,
      reviews_readable: true,
      ci: { workflows: 3, required_checks: [] },
    });
    expect(typeof f.view).toBe("object");
    // Unprotected: the admin-only protection read is not made.
    expect(fake.argvs(api(`branches/${B}/protection`))).toEqual([]);
    expect(factsUnknown(f)).toBe(false);
  });

  it("a pull_request rule's approving reviews, and the required checks of rules and protection", async () => {
    const fake = github()
      .on(api(`rules/branches/${B}`), {
        stdout: JSON.stringify([
          { type: "pull_request", parameters: { required_approving_review_count: 1 } },
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "test" }] },
          },
        ]),
      })
      .on(api(`branches/${B}`), {
        stdout: JSON.stringify({
          protected: true,
          protection: { required_status_checks: { contexts: ["build"] } },
        }),
      })
      .on(api(`branches/${B}/protection`), {
        stdout: JSON.stringify({
          required_pull_request_reviews: { required_approving_review_count: 2 },
        }),
      });
    const f = await readRepoCheck(fake.exec, SLUG, B);
    expect(f.required_reviews).toBe(2);
    expect(f.reviews_readable).toBe(true);
    expect(f.ci?.required_checks).toEqual(["build", "test"]);
  });

  it("classic protection a non-admin cannot read (403): reviews unknown", async () => {
    const fake = github()
      .on(api(`branches/${B}`), { stdout: JSON.stringify({ protected: true, protection: {} }) })
      .on(api(`branches/${B}/protection`), { code: 1, stderr: "gh: Forbidden (HTTP 403)\n" });
    const f = await readRepoCheck(fake.exec, SLUG, B);
    expect(f.reviews_readable).toBe(false);
    expect(factsUnknown(f)).toBe(true);
  });

  it("a branch only rulesets protect (protected: true, /protection 404): reviews read from the rules", async () => {
    const fake = github()
      .on(api(`rules/branches/${B}`), {
        stdout: JSON.stringify([
          { type: "pull_request", parameters: { required_approving_review_count: 1 } },
        ]),
      })
      .on(api(`branches/${B}`), { stdout: JSON.stringify({ protected: true, protection: {} }) })
      .on(api(`branches/${B}/protection`), {
        code: 1,
        stderr: "gh: Branch not protected (HTTP 404)\n",
      });
    const f = await readRepoCheck(fake.exec, SLUG, B);
    expect(f.reviews_readable).toBe(true);
    expect(f.required_reviews).toBe(1);
    expect(factsUnknown(f)).toBe(false);
  });

  it("a branch GitHub answers 404 for is not on origin; its CI mode is not read (never none from it)", async () => {
    const fake = github().on(api(`branches/${B}`), notFound);
    const f = await readRepoCheck(fake.exec, SLUG, B);
    expect(f.branch_exists).toBe(false);
    expect(f.ci).toBeNull();
    expect(factsUnknown(f)).toBe(false);
    expect(repositoryChecks(f).find((c) => c.id === "ci.mode")?.detail).toBe(
      `not read: ${B} is not on origin yet`,
    );
  });

  it("in a clone (admission of a wave named by its path): gh resolves {owner}/{repo}, no repo view", async () => {
    const fake = fakeExec()
      .on(["gh", "api", "repos/{owner}/{repo}/actions/workflows?per_page=100"], workflows(1))
      .on(["gh", "api", `repos/{owner}/{repo}/branches/${B}`], { stdout: "{}" })
      .on(["gh", "api", `repos/{owner}/{repo}/rules/branches/${B}`], { stdout: "[]" });
    const f = await readRepoFacts(fake.exec, { cwd: "/repo" }, SLUG, B);
    expect(f).toMatchObject({ view: null, ci: { workflows: 1 }, branch_exists: true });
    expect(fake.argvs(["gh", "repo"])).toEqual([]);
    expect(fake.calls.every((c) => c.opts.cwd === "/repo")).toBe(true);
  });

  it("only the workflows unreadable: CI mode unknown (ci_mode_unknown's alarm), no refusal fact unknown", async () => {
    const fake = github().on(api("actions/workflows?per_page=100"), {
      code: 1,
      stderr: "HTTP 403: rate limit",
    });
    const f = await readRepoCheck(fake.exec, SLUG, B);
    expect(f).toMatchObject({ ci: null, branch_exists: true, reviews_readable: true });
    expect(factsUnknown(f)).toBe(false);
  });

  it("any read failing is a fact unknown, never a throw", async () => {
    const fake = fakeExec()
      .on(VIEW, { code: 1, stderr: "HTTP 403: rate limit" })
      .on(["gh", "api"], { code: 1, stderr: "HTTP 403: rate limit" });
    const f = await readRepoCheck(fake.exec, SLUG, B);
    expect(f).toMatchObject({ ci: null, branch_exists: null, reviews_readable: false });
    expect(typeof f.view).toBe("string");
    expect(factsUnknown(f)).toBe(true);
    const thrown = await readRepoCheck(
      async () => {
        throw new Error("boom");
      },
      SLUG,
      B,
    );
    expect(thrown.ci).toBeNull();
  });

  it("without a branch only the view and the workflows are read (repo_add)", async () => {
    const fake = github(0);
    const f = await readRepoCheck(fake.exec, SLUG, null);
    expect(repositoryChecks(f).map((c) => c.id)).toEqual(["repo.exists", "ci.mode"]);
    expect(fake.argvs(["gh", "api"])).toEqual([api("actions/workflows?per_page=100")]);
  });
});

const facts = (over: Partial<RepoFacts> = {}): RepoFacts => ({
  slug: SLUG,
  view: { slug: SLUG, url: `https://github.com/${SLUG}`, visibility: "private" },
  ci: { workflows: 3, required_checks: [] },
  branch: B,
  branch_exists: true,
  required_reviews: 0,
  reviews_readable: true,
  ...over,
});
const line = (f: RepoFacts, id: string) => repositoryChecks(f).find((c) => c.id === id);

describe("repositoryChecks", () => {
  it("the four lines, in order, all passing", () => {
    const checks = repositoryChecks(facts());
    expect(checks.map((c) => [c.id, c.ok])).toEqual([
      ["repo.exists", true],
      ["branch.release", true],
      ["branch.protection", true],
      ["ci.mode", true],
    ]);
    expect(line(facts(), "repo.exists")?.detail).toBe(`GitHub knows it as ${SLUG}`);
    expect(line(facts(), "branch.release")?.detail).toBe(`${B} exists on origin`);
    expect(line(facts(), "branch.protection")?.detail).toBe("reviews: none");
    // volleyd status's words.
    expect(line(facts(), "ci.mode")?.detail).toBe("workflows (3)");
    expect(line(facts({ ci: { workflows: 0, required_checks: [] } }), "ci.mode")?.detail).toBe(
      "none (no workflows: the two reviewers and the gate are the check)",
    );
    expect(
      line(facts({ ci: { workflows: 1, required_checks: ["test"] } }), "ci.mode")?.detail,
    ).toBe("required (test)");
  });

  it("an approving review: a warn naming merge: manual", () => {
    const c = line(facts({ required_reviews: 1 }), "branch.protection");
    expect(c).toMatchObject({ ok: false, severity: "warn" });
    expect(c?.detail).toBe(
      `${B} requires 1 approving review: GitHub will refuse volleyd's merge: auto`,
    );
    expect(c?.fix).toBe("set merge: manual in the wave file, or drop the rule for this branch");
  });

  it("reviews not readable: a warn, reviews unknown", () => {
    const c = line(facts({ reviews_readable: false }), "branch.protection");
    expect(c).toMatchObject({
      ok: false,
      severity: "warn",
      detail: "reviews: unknown (classic protection is admin-only)",
    });
  });

  it("a branch not on origin blocks, with the push; no protection line", () => {
    const f = facts({ branch_exists: false });
    expect(line(f, "branch.release")).toMatchObject({ ok: false, severity: "block" });
    expect(line(f, "branch.release")?.fix).toContain(`refs/heads/${B}`);
    expect(line(f, "branch.protection")).toBeUndefined();
  });

  it("gh repo view failing blocks repo.exists in gh's words", () => {
    const c = line(facts({ view: "gh repo view no/such: Could not resolve" }), "repo.exists");
    expect(c).toMatchObject({
      ok: false,
      severity: "block",
      detail: "gh repo view no/such: Could not resolve",
    });
  });
});

const record = (checks: MachineRecord["checks"]): MachineRecord =>
  ({
    name: "box-a",
    kind: "peer",
    os: "linux",
    cores: 8,
    tunnel: "up",
    load: [0, 0, 0],
    agents: 0,
    last_seen: "2026-10-25T09:00:00.000Z",
    checks,
    doctor_at: "2026-10-25T08:59:00.000Z",
  }) as MachineRecord;

describe("machineBlock and the closing line", () => {
  const checks = [
    { id: "tool.git", ok: true, severity: "block" as const, detail: "git 2.43" },
    { id: "repo.clone", ok: true, severity: "block" as const, repo: SLUG, detail: "clone at /c" },
    { id: "repo.clone", ok: true, severity: "block" as const, repo: "o/other", detail: "x" },
    {
      id: "git.identity",
      ok: false,
      severity: "warn" as const,
      detail: "git has no commit identity",
    },
    { id: "claude.trust", ok: true, severity: "warn" as const, detail: "trusted" },
  ];

  it("the repository's checks and the machine-level ones; a record's failing line gets its fix", () => {
    const b = machineBlock(
      SLUG,
      record(checks),
      undefined,
      {
        ready: false,
        reasons: ["git: no commit identity on box-a (volley setup --peer --step signin)"],
      },
      { state: "ready", path: "/c", reasons: [] },
      { from: "record", note: "a doctor run is in progress" },
    );
    expect(b.checks.map((c) => c.id)).toEqual(["repo.clone", "git.identity", "claude.trust"]);
    expect(b.checks[1]?.fix).toBe("volley setup --peer --step signin");
    expect(b).toMatchObject({ ready: false, state: "ready", from: "record" });
    const ok = machineBlock(
      SLUG,
      record(checks.slice(0, 2)),
      undefined,
      { ready: true, reasons: [] },
      { state: "ready", reasons: [] },
      { from: "doctor" },
    );
    expect(ok.ready).toBe(true);
    expect(closingLine({ "box-a": b, control: ok })).toBe(
      "not ready for a wave on box-a (git.identity); ready on control.",
    );
    expect(closingLine({ control: ok })).toBe("ready for a wave on: control.");
  });

  it("#631: a record's failing repo.identity is picked for its slug and gets its fix, naming the clone", () => {
    const rec = {
      ...record([
        {
          id: "repo.identity",
          ok: false,
          severity: "block" as const,
          repo: SLUG,
          detail: "no commit identity in /c",
        },
        { id: "repo.identity", ok: true, severity: "block" as const, repo: "o/other", detail: "x" },
      ]),
      repos: [
        {
          slug: SLUG,
          path: "/c",
          exists: true,
          managed: true,
          fetched_at: null,
          toolchain: { ok: true, missing: [], outdated: [] },
        },
      ],
    } as MachineRecord;
    const b = machineBlock(
      SLUG,
      rec,
      undefined,
      { ready: true, reasons: [] },
      { state: "blocked", path: "/c", reasons: ["repo.identity: no commit identity in /c"] },
      { from: "record" },
    );
    expect(b.checks.map((c) => c.id)).toEqual(["repo.identity"]);
    expect(b.checks[0]?.fix).toBe(
      'git -C /c config user.name "<name>" && git -C /c config user.email <email>, or volley setup --peer --step signin',
    );
  });

  it("#631: the closing line does not name git.identity while a clone commits under its own", () => {
    const b = machineBlock(
      SLUG,
      record([
        { id: "tool.tmux", ok: false, severity: "block" as const, detail: "no tmux" },
        { id: "git.identity", ok: false, severity: "warn" as const, detail: "no global" },
        { id: "repo.identity", ok: true, severity: "block" as const, repo: SLUG, detail: "ok" },
      ]),
      undefined,
      { ready: false, reasons: ["tmux missing"] },
      { state: "ready", path: "/c", reasons: [] },
      { from: "record" },
    );
    expect(closingLine({ "box-a": b })).toBe("not ready for a wave on box-a (tool.tmux).");
  });

  it("#631: the closing line follows readiness when only another repository's clone commits", () => {
    const b = machineBlock(
      SLUG,
      record([
        { id: "git.identity", ok: false, severity: "warn" as const, detail: "no global" },
        {
          id: "repo.identity",
          ok: true,
          severity: "block" as const,
          repo: "o/other",
          detail: "ok",
        },
        {
          id: "repo.identity",
          ok: false,
          severity: "block" as const,
          repo: SLUG,
          detail: "no commit identity in /c",
        },
      ]),
      undefined,
      { ready: true, reasons: [] },
      { state: "blocked", path: "/c", reasons: ["repo.identity: no commit identity in /c"] },
      { from: "record" },
    );
    expect(closingLine({ "box-a": b })).toBe("not ready for a wave on box-a (repo.identity).");
  });

  it("no record: not ready, the readiness reason", () => {
    const b = machineBlock(
      SLUG,
      undefined,
      undefined,
      { ready: false, reasons: ["no machine record from box-a yet: is its service running?"] },
      undefined,
      { from: "record" },
    );
    expect(b).toMatchObject({ ready: false, state: "none", checks: [] });
    expect(closingLine({ "box-a": b })).toBe(
      "not ready for a wave on box-a (no machine record from box-a yet: is its service running?).",
    );
  });

  it("the supervisor's own machine is never fixed: its failing clone lines name the doctor to run there", () => {
    const failing = [
      {
        id: "repo.fetch",
        ok: false,
        severity: "block" as const,
        repo: SLUG,
        detail: "fetch failed",
      },
    ];
    const peerBlock = machineBlock(
      SLUG,
      record(failing),
      undefined,
      { ready: true, reasons: [] },
      undefined,
      { from: "record" },
    );
    expect(peerBlock.checks[0]?.fix).toBe(`volley repo check ${SLUG} --fix`);
    const own = machineBlock(
      SLUG,
      record(failing),
      undefined,
      { ready: true, reasons: [] },
      undefined,
      { from: "doctor", own: true },
    );
    expect(own.checks[0]?.fix).toBe(
      "volley peer doctor --repo <the clone> --fix, on this machine (volleyd never fixes its own clone)",
    );
  });

  it("#638: the checked repository's claude.trust, not another's; a failing record line gets a fix", () => {
    const perRepo = [
      { id: "tool.git", ok: true, severity: "block" as const, detail: "git 2.43" },
      { id: "repo.clone", ok: true, severity: "block" as const, repo: SLUG, detail: "clone at /c" },
      {
        id: "claude.trust",
        ok: false,
        severity: "warn" as const,
        repo: SLUG,
        detail: "Claude Code does not trust /c yet",
      },
      {
        id: "claude.trust",
        ok: true,
        severity: "warn" as const,
        repo: "o/other",
        detail: "Claude Code trusts /other",
      },
    ];
    const rec = record(perRepo);
    const b = machineBlock(
      SLUG,
      {
        ...rec,
        repos: [
          {
            slug: SLUG,
            path: "/c",
            exists: true,
            managed: true,
            fetched_at: null,
            toolchain: { ok: true, missing: [], outdated: [] },
          },
        ],
      },
      undefined,
      { ready: true, reasons: [] },
      { state: "ready", path: "/c", reasons: [] },
      { from: "record" },
    );
    const trust = b.checks.filter((c) => c.id === "claude.trust");
    expect(trust).toHaveLength(1);
    expect(trust[0]).toMatchObject({ repo: SLUG, detail: "Claude Code does not trust /c yet" });
    expect(trust[0]?.fix).toBe("run claude in /c once and accept the trust dialog");
  });

  it("#638: a record's repo.identity failing the expected email shows with the email fix", () => {
    const b = machineBlock(
      SLUG,
      {
        ...record([
          {
            id: "repo.identity",
            ok: false,
            severity: "block" as const,
            repo: SLUG,
            detail: "commits as Dev <other@example.com>, expected dev@example.com",
          },
        ]),
        repos: [
          {
            slug: SLUG,
            path: "/c",
            exists: true,
            managed: true,
            fetched_at: null,
            toolchain: { ok: true, missing: [], outdated: [] },
          },
        ],
      },
      undefined,
      { ready: true, reasons: [] },
      { state: "blocked", path: "/c", reasons: [] },
      { from: "record" },
    );
    expect(b.checks.find((c) => c.id === "repo.identity")?.fix).toBe(
      "git -C /c config user.email dev@example.com",
    );
  });
});

const peer = (name: string, over: Partial<Candidate> = {}): Candidate => ({
  name,
  pinned: false,
  local: false,
  ready: true,
  reasons: [],
  repo: { state: "ready", path: `/srv/${name}`, reasons: [] },
  cloneLacksIdentity: false,
  ...over,
});
const W = { slug: SLUG, release_branch: B, merge: "manual" as const, spawnsLocally: false };

describe("admissionRefusals (D7)", () => {
  it("a ready candidate admits; a second one not ready is a line, not a refusal", () => {
    const r = admissionRefusals(W, facts(), [
      peer("box-a"),
      peer("box-b", { repo: { state: "absent", reasons: [`no clone of ${SLUG} on box-b`] } }),
    ]);
    expect(r.refusals).toEqual([]);
    expect(r.lines).toEqual([`! box-b: absent (no clone of ${SLUG} on box-b)`]);
  });

  it("one candidate still cloning admits (placement waits for it)", () => {
    const r = admissionRefusals(W, facts(), [
      peer("box-a", { repo: { state: "cloning", reasons: [] } }),
    ]);
    expect(r.refusals).toEqual([]);
  });

  it("none ready: refused, each candidate's line and the fix", () => {
    const r = admissionRefusals(W, facts(), [
      peer("box-a", { repo: { state: "absent", reasons: [`no clone of ${SLUG} on box-a`] } }),
      peer("box-b", { ready: false, reasons: ["tunnel down to box-b: no heartbeat"] }),
    ]);
    expect(r.refusals).toEqual([
      {
        path: "repo",
        reason: `no machine that could run this wave is ready for ${SLUG}: box-a: absent (no clone of ${SLUG} on box-a); box-b: not ready (tunnel down to box-b: no heartbeat); fix: volley repo check ${SLUG} --fix, or volley repo add ${SLUG} --machine box-a`,
      },
    ]);
  });

  it("a task pinned to a machine not ready for the repository: that machine's line", () => {
    const r = admissionRefusals(W, facts(), [
      peer("box-a"),
      peer("box-b", {
        pinned: true,
        repo: { state: "blocked", reasons: ["repo.push: octocat cannot push"] },
      }),
    ]);
    expect(r.refusals).toEqual([
      {
        path: "repo",
        reason: `a task is pinned to box-b, which is not ready for ${SLUG}: box-b: blocked (repo.push: octocat cannot push)`,
      },
    ]);
  });

  it("the only candidate without a git identity: refused, naming the fix", () => {
    const r = admissionRefusals(W, facts(), [
      peer("box-a", {
        ready: false,
        reasons: ["git: no commit identity on box-a (volley setup --peer --step signin)"],
      }),
    ]);
    expect(r.refusals[0]?.reason).toContain(
      "box-a: not ready (git: no commit identity on box-a (volley setup --peer --step signin))",
    );
  });

  it("merge: auto on a branch that requires an approving review is refused; merge: manual is a line", () => {
    const auto = admissionRefusals({ ...W, merge: "auto" }, facts({ required_reviews: 1 }), [
      peer("box-a"),
    ]);
    expect(auto.refusals).toEqual([
      {
        path: "repo",
        reason: `merge: auto cannot be honoured: ${B} requires 1 approving review, and GitHub refuses volleyd's own merge; set merge: manual, or drop the rule for ${B}`,
      },
    ]);
    const manual = admissionRefusals(W, facts({ required_reviews: 1 }), [peer("box-a")]);
    expect(manual.refusals).toEqual([]);
    expect(manual.lines).toEqual([
      `! branch.protection: ${B} requires 1 approving review: GitHub will refuse volleyd's merge: auto (fix: set merge: manual in the wave file, or drop the rule for this branch)`,
    ]);
  });

  it("a release branch not on origin: refused for a wave that spawns on paired machines only; a local wave keeps releaseBranchMissing's words", () => {
    const missing = facts({ branch_exists: false });
    const remote = admissionRefusals(W, missing, [peer("box-a")]);
    expect(remote.refusals[0]?.reason).toMatch(
      new RegExp(`^branch\\.release: ${B} is not on origin`),
    );
    const local = admissionRefusals({ ...W, spawnsLocally: true }, missing, [
      peer("control", { local: true }),
    ]);
    expect(local.refusals).toEqual([]);
  });

  it("the supervisor's own machine admits its local tasks whatever its clone verdict, unless it has no git identity", () => {
    const own = peer("control", { local: true, ready: false, repo: undefined });
    expect(admissionRefusals({ ...W, spawnsLocally: true }, facts(), [own]).refusals).toEqual([]);
    const none = admissionRefusals({ ...W, spawnsLocally: true }, facts(), [
      { ...own, cloneLacksIdentity: true, clone: "/srv/control" },
    ]);
    expect(none.refusals[0]?.reason).toContain(
      'control: no commit identity in /srv/control (git -C /srv/control config user.name "<name>" && git -C /srv/control config user.email <email>, or volley setup --peer --step signin)',
    );
    const spaced = admissionRefusals({ ...W, spawnsLocally: true }, facts(), [
      { ...own, cloneLacksIdentity: true, clone: "/srv/my clone" },
    ]);
    expect(spaced.refusals[0]?.reason).toContain(
      "(git -C '/srv/my clone' config user.name \"<name>\" && git -C '/srv/my clone' config user.email <email>,",
    );
  });

  it("#631: a peer whose clone lacks an identity is refused by its repository verdict", () => {
    const r = admissionRefusals(W, facts(), [
      peer("box-a", {
        repo: {
          state: "blocked",
          path: "/srv/box-a",
          reasons: ["repo.identity: no commit identity in /srv/box-a"],
        },
      }),
    ]);
    expect(r.refusals[0]?.reason).toContain(
      "box-a: blocked (repo.identity: no commit identity in /srv/box-a)",
    );
  });

  it("#631: the own machine whose clone commits admits its local tasks", () => {
    const own = peer("control", { local: true, ready: false, repo: undefined });
    expect(
      admissionRefusals({ ...W, spawnsLocally: true }, facts(), [
        { ...own, cloneLacksIdentity: false },
      ]).refusals,
    ).toEqual([]);
  });

  it("unread facts (null) refuse nothing about the repository", () => {
    expect(admissionRefusals({ ...W, merge: "auto" }, null, [peer("box-a")])).toEqual({
      refusals: [],
      lines: [],
    });
  });
});

describe("lacksIdentity (#631)", () => {
  const gi = (ok: boolean) => ({ id: "git.identity", ok, severity: "warn" as const, detail: "" });
  const ri = (ok: boolean, repo: string) => ({
    id: "repo.identity",
    ok,
    severity: "block" as const,
    detail: "",
    repo,
  });
  it("a failing repo.identity of the slug: lacks one", () => {
    expect(lacksIdentity(record([gi(true), ri(false, SLUG)]), SLUG)).toBe(true);
  });
  it("a failing git.identity with no passing repo.identity: lacks one", () => {
    expect(lacksIdentity(record([gi(false)]), SLUG)).toBe(true);
  });
  it("a failing git.identity with a passing repo.identity of any slug: has one", () => {
    expect(lacksIdentity(record([gi(false), ri(true, "o/other")]), SLUG)).toBe(false);
    expect(lacksIdentity(record([gi(false), ri(true, SLUG)]), SLUG)).toBe(false);
  });
  it("no record: has nothing against it", () => {
    expect(lacksIdentity(undefined, SLUG)).toBe(false);
  });
});
