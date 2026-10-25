import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { type AddDeps, makeAdd } from "../src/commands/add";
import { makeBufferIO } from "../src/io";
import { type FakeExec, fakeExec } from "./helpers/fake-exec";
import { runCli } from "./helpers/run-cli";
import { type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

const OWNER = "coord";

const facts = (number: number, title: string, body: string, state = "OPEN") =>
  JSON.stringify({
    number,
    title,
    body,
    url: `https://github.com/o/r/issues/${number}`,
    state,
    labels: [],
  });
const B13 = facts(602, "B13: add the thing", "Depends on: #42\n\n## Files\n\n- `src/new.ts`\n");

let s: SupervisedEnv | undefined;
afterEach(async () => {
  await s?.cleanup();
  s = undefined;
});

/**
 * A supervised wave w1 (T1, issue 42) owned by OWNER, its file at `<repo>/.volley/waves/w1.yaml`
 * as submitted, and `add` over a fake gh answering #602.
 */
async function world(gh: FakeExec = fakeExec().on(["gh", "issue", "view"], { stdout: B13 })) {
  s = await makeSupervisedEnv({ owner: OWNER });
  const file = join(s.repo, ".volley", "waves", "w1.yaml");
  mkdirSync(join(s.repo, ".volley", "waves"), { recursive: true });
  writeFileSync(file, readFileSync(join(s.env.home, "w1.yaml")));
  const before = readFileSync(file, "utf-8");
  const repo = s.repo;
  const deps: AddDeps = {
    exec: gh.exec,
    readFile: (p) => readFile(p, "utf-8"),
    writeFile: (p, t) => writeFile(p, t),
    waveTree: async () => ({ "src/new.ts": 900 }),
    cwd: () => repo,
  };
  const add = async (argv: string[], over: Partial<AddDeps> = {}) => {
    const io = makeBufferIO();
    const exitCode = await makeAdd({ ...deps, ...over })({
      argv,
      env: s?.env.env ?? {},
      io,
    });
    return { exitCode, stdout: io.readStdout(), stderr: io.readStderr() };
  };
  return { s, file, before, gh, add };
}

describe("volleyd add", () => {
  it("the owner adds #602: the file gains the task, the daemon queues it after T1", async () => {
    const w = await world();
    const r = await w.add(["w1", "602", "--by", OWNER]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("submitted wave w1 plan v2\n");
    expect(r.stdout).toContain("+ B13\n");
    expect(r.stdout).toContain('B13: #602 "B13: add the thing" after [T1]\n');
    expect(r.stdout).toContain(`wave file: ${w.file}\n`);
    const after = readFileSync(w.file, "utf-8");
    expect(after.startsWith(w.before.slice(0, w.before.indexOf("config:")))).toBe(true);
    expect(after).toContain(
      '  B13:\n    issue: 602\n    title: "B13: add the thing"\n    after: [T1]\n',
    );
    expect(after.endsWith(w.before.slice(w.before.indexOf("config:")))).toBe(true);
    const rec = w.s.daemon.record("w1");
    expect(rec?.state?.tasks.find((t) => t.id === "B13")).toMatchObject({
      issue: 602,
      stage: "queued",
    });
    expect((rec?.plan ?? rec?.wave)?.tasks.B13?.after).toEqual(["T1"]);
    // gh ran with the wave's repository directory (the daemon read no GitHub name here).
    expect(w.gh.calls[0]?.opts.cwd).toBe(w.s.repo);
  });

  it("--json carries what was added", async () => {
    const w = await world();
    const r = await w.add(["w1", "#602", "--by", OWNER, "--json"]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.added).toEqual([{ id: "B13", issue: 602, after: ["T1"] }]);
    expect(out.file).toBe(w.file);
    expect(out.plan.version).toBe(2);
    expect(out.state.wave).toBe("w1");
  });

  it("a caller who is not the owner is refused, the file restored byte for byte", async () => {
    const w = await world();
    const r = await w.add(["w1", "602", "--by", "someone-else"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("already running under owner coord");
    expect(r.stderr).toContain(`restored ${w.file}`);
    expect(readFileSync(w.file, "utf-8")).toBe(w.before);
  });

  it("no caller identity: refused with the --by hint, nothing fetched", async () => {
    const w = await world();
    const r = await w.add(["w1", "602"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("pass --by");
    expect(w.gh.calls).toEqual([]);
    expect(readFileSync(w.file, "utf-8")).toBe(w.before);
  });

  it("a stopped wave is refused before any gh call", async () => {
    const w = await world();
    expect((await runCli(["stop", "w1", "--by", OWNER], w.s.env.env)).exitCode).toBe(0);
    const r = await w.add(["w1", "602", "--by", OWNER]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("wave 'w1' is stopped; nothing can be added to it");
    expect(w.gh.calls).toEqual([]);
    expect(readFileSync(w.file, "utf-8")).toBe(w.before);
  });

  it("a complete or releasing wave is refused before any gh call", async () => {
    const w = await world();
    await w.s.daemon.recordEvent("w1", { type: "release_started", data: {} });
    const releasing = await w.add(["w1", "602", "--by", OWNER]);
    expect(releasing.stderr).toContain("wave 'w1' is releasing; nothing can be added to it");
    await w.s.daemon.recordEvent("w1", { type: "release_done", data: {} });
    const complete = await w.add(["w1", "602", "--by", OWNER]);
    expect(complete.stderr).toContain("wave 'w1' is complete; nothing can be added to it");
    expect(w.gh.calls).toEqual([]);
    expect(readFileSync(w.file, "utf-8")).toBe(w.before);
  });

  it("an unknown wave is refused with the way to start one", async () => {
    const w = await world();
    const r = await w.add(["nope", "602", "--by", OWNER, "--file", w.file]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "unknown wave 'nope' (volleyd status lists them; a new wave starts with wave-from-issues + volleyd run)",
    );
  });

  it("a paused wave takes the task, which starts on resume", async () => {
    const w = await world();
    expect((await runCli(["pause", "w1", "--by", OWNER], w.s.env.env)).exitCode).toBe(0);
    const r = await w.add(["w1", "602", "--by", OWNER]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("wave w1 is paused: B13 is queued and starts on resume\n");
  });

  it("a file that differs from the plan is refused before any gh call", async () => {
    const w = await world();
    const drifted = w.before.replace("tasks:\n", "tasks:\n  T9: { issue: 99 }\n");
    writeFileSync(w.file, drifted);
    const r = await w.add(["w1", "602", "--by", OWNER]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`${w.file} differs from plan v1 (+ 1 / - 0)`);
    expect(w.gh.calls).toEqual([]);
    expect(readFileSync(w.file, "utf-8")).toBe(drifted);
  });

  it("an issue already in the wave is refused before any gh call", async () => {
    const w = await world();
    const r = await w.add(["w1", "42", "--by", OWNER]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("#42 is already in wave w1 as T1");
    expect(w.gh.calls).toEqual([]);
  });

  it("a closed issue is refused, the file untouched", async () => {
    const gh = fakeExec().on(["gh", "issue", "view"], {
      stdout: facts(602, "B13: x", "Depends on: none", "CLOSED"),
    });
    const w = await world(gh);
    const r = await w.add(["w1", "602", "--by", OWNER]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("#602 is closed; reopen it or pick another issue");
    expect(readFileSync(w.file, "utf-8")).toBe(w.before);
  });

  it("an open dependency outside the wave is refused with the way out", async () => {
    const gh = fakeExec().on(["gh", "issue", "view"], (argv) => ({
      stdout:
        argv[3] === "602"
          ? facts(602, "B13: x", "Depends on: #590")
          : facts(590, "elsewhere", "Depends on: none"),
    }));
    const w = await world(gh);
    const r = await w.add(["w1", "602", "--by", OWNER]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "#602 depends on #590, which is not in wave w1 and is open: add it too (volleyd add w1 590 602) or close it first",
    );
    expect(readFileSync(w.file, "utf-8")).toBe(w.before);
  });

  it("gh failing is printed as gh said it, nothing written", async () => {
    const gh = fakeExec().on(["gh", "issue", "view"], {
      code: 1,
      stderr: "GraphQL: Could not resolve to an issue or pull request with the number of 602.\n",
    });
    const w = await world(gh);
    const r = await w.add(["w1", "602", "--by", OWNER]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Could not resolve to an issue");
    expect(readFileSync(w.file, "utf-8")).toBe(w.before);
  });

  it("a version the daemon refuses restores the file byte for byte", async () => {
    const w = await world();
    // The release branch is gone: the daemon's RELEASE_BRANCH_MISSING refuses the version.
    w.s.host.fake.on(["git", "-C", w.s.repo, "rev-parse", "--verify"], { code: 1 });
    const r = await w.add(["w1", "602", "--by", OWNER]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("RELEASE_BRANCH_MISSING");
    expect(r.stderr).toContain(`restored ${w.file}\n`);
    expect(readFileSync(w.file, "utf-8")).toBe(w.before);
    expect(w.gh.calls.length).toBeGreaterThan(0);
  });

  it("no answer to the submit keeps the file as submitted and names volleyd diff", async () => {
    const w = await world();
    // The daemon's check of the release branch outlasts the submit's wait: it is held until the
    // add has given up, so no answer arrives in time.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    w.s.host.fake.on(["git", "-C", w.s.repo, "rev-parse", "--verify"], async () => {
      await held;
      return { stdout: "abc\n" };
    });
    const r = await w.add(["w1", "602", "--by", OWNER], { submitTimeoutMs: 300 });
    release();
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toContain(
      `no answer to the submit; ${w.file} is kept as submitted: check it with volleyd diff w1 ${w.file}`,
    );
    const now = readFileSync(w.file, "utf-8");
    expect(now).not.toBe(w.before);
    expect(now).toContain("  B13:\n    issue: 602\n");
  });

  it("an --after that is no task is a usage error listing the wave's ids", async () => {
    const w = await world();
    const r = await w.add(["w1", "602", "--after", "T7", "--by", OWNER]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--after T7: no such task in wave w1 (its tasks: T1)");
  });

  it("no --file and no .volley/waves/<wave>.yaml here → usage, naming the path and --file", async () => {
    const w = await world();
    const r = await w.add(["w1", "602", "--by", OWNER], { cwd: () => w.s.env.home });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(join(w.s.env.home, ".volley", "waves", "w1.yaml"));
    expect(r.stderr).toContain("--file");
  });
});

describe("volleyd add (CLI)", () => {
  it("add --help prints the usage; volleyd --help lists add", async () => {
    const help = makeBufferIO();
    expect(await main({ argv: ["add", "--help"], env: {}, io: help })).toBe(0);
    expect(help.readStdout()).toContain("Usage: volleyd add <wave> <issue...>");
    const top = await runCli(["--help"]);
    expect(top.stdout).toMatch(/^ {2}add {9}Add issues to a running wave/m);
  });
});
