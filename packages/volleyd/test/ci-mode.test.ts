import { describe, expect, it } from "vitest";
import { type CiModeFacts, readCiFacts, resolveCiMode } from "../src/ci-mode";
import { fakeExec } from "./helpers/fake-exec";

const WORKFLOWS = ["gh", "api", "repos/{owner}/{repo}/actions/workflows?per_page=100"];
const BRANCH = ["gh", "api", "repos/{owner}/{repo}/branches/release/w1"];
const RULES = ["gh", "api", "repos/{owner}/{repo}/rules/branches/release/w1"];

const workflows = (...states: string[]) => ({
  stdout: JSON.stringify({
    total_count: states.length,
    workflows: states.map((state, i) => ({ id: i + 1, name: `w${i}`, state })),
  }),
});
const unprotected = { stdout: JSON.stringify({ name: "release/w1", protected: false }) };
const noRules = { stdout: "[]" };

describe("readCiFacts", () => {
  it("counts only active workflows (a disabled one does not count)", async () => {
    const fake = fakeExec()
      .on(WORKFLOWS, workflows("disabled_manually"))
      .on(BRANCH, unprotected)
      .on(RULES, noRules);
    expect(await readCiFacts(fake.exec, { cwd: "/repo" }, "release/w1")).toEqual({
      workflows: 0,
      required_checks: [],
    });
    expect(fake.calls.every((c) => c.opts.cwd === "/repo")).toBe(true);
  });

  it("merges protection and ruleset contexts, deduplicated", async () => {
    const fake = fakeExec()
      .on(WORKFLOWS, workflows("active", "active", "disabled_inactivity"))
      .on(BRANCH, {
        stdout: JSON.stringify({
          protected: true,
          protection: { required_status_checks: { contexts: ["build", "test"] } },
        }),
      })
      .on(RULES, {
        stdout: JSON.stringify([
          { type: "pull_request", parameters: {} },
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "test" }, { context: "lint" }] },
          },
        ]),
      });
    expect(await readCiFacts(fake.exec, { cwd: "/repo" }, "release/w1")).toEqual({
      workflows: 2,
      required_checks: ["build", "test", "lint"],
    });
  });

  it("a slug reads repos/<slug>/… with no cwd; no branch reads workflows only", async () => {
    const fake = fakeExec().on(
      ["gh", "api", "repos/example-org/example-repo/actions/workflows?per_page=100"],
      workflows(),
    );
    expect(await readCiFacts(fake.exec, { slug: "example-org/example-repo" }, null)).toEqual({
      workflows: 0,
      required_checks: [],
    });
    expect(fake.argvs()).toHaveLength(1);
    expect(fake.calls[0]?.opts.cwd).toBeUndefined();
  });

  it("a failing, timed-out or unparseable read is null facts", async () => {
    const failing = fakeExec()
      .on(WORKFLOWS, { code: 1, stderr: "HTTP 403" })
      .on(BRANCH, unprotected)
      .on(RULES, noRules);
    expect(await readCiFacts(failing.exec, { cwd: "/repo" }, "release/w1")).toBeNull();
    const timedOut = fakeExec()
      .on(WORKFLOWS, workflows())
      .on(BRANCH, { code: 124, timedOut: true })
      .on(RULES, noRules);
    expect(await readCiFacts(timedOut.exec, { cwd: "/repo" }, "release/w1")).toBeNull();
    const empty = fakeExec();
    expect(await readCiFacts(empty.exec, { cwd: "/repo" }, "release/w1")).toBeNull();
  });
});

describe("resolveCiMode", () => {
  const none: CiModeFacts = { workflows: 0, required_checks: [] };
  const some: CiModeFacts = { workflows: 3, required_checks: [] };
  const required: CiModeFacts = { workflows: 1, required_checks: ["build", "test"] };
  const B = "release/w1";

  it.each([
    [undefined, none, { mode: "none", source: "gh" }],
    ["auto", none, { mode: "none", source: "gh" }],
    ["auto", some, { mode: "workflows", source: "gh", workflows: 3 }],
    ["auto", required, { mode: "required", source: "gh", required_checks: ["build", "test"] }],
    ["none", none, { mode: "none", source: "wave_file" }],
    ["none", some, { mode: "none", source: "wave_file" }],
    ["required", none, { mode: "required", source: "wave_file" }],
    ["required", some, { mode: "required", source: "wave_file" }],
    ["required", required, { mode: "required", source: "wave_file" }],
  ] as const)("ci: %s over %j → %j", (override, facts, want) => {
    const got = resolveCiMode(override, facts, B);
    expect(got).toMatchObject(want);
    expect("unknown" in got).toBe(false);
  });

  it("ci: none on a branch with required checks is refused, naming them", () => {
    const got = resolveCiMode("none", required, B);
    expect(got).toHaveProperty("refused");
    expect((got as { refused: string }).refused).toContain(
      "release/w1 requires the checks build, test",
    );
  });

  it("unreadable facts under auto are workflows, flagged unknown; never none", () => {
    expect(resolveCiMode("auto", null, B)).toEqual({
      mode: "workflows",
      workflows: null,
      required_checks: [],
      source: "gh",
      unknown: true,
    });
    expect(resolveCiMode("required", null, B)).toMatchObject({ mode: "required" });
    expect(resolveCiMode("none", null, B)).toMatchObject({ mode: "none", source: "wave_file" });
  });
});
