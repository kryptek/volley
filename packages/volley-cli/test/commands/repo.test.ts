import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { useSavedLogin } from "../../src/auth/coordinator-login";
import type { Answer } from "../../src/commands/peer";
import { type RepoDeps, realRepoDeps, runRepo } from "../../src/commands/repo";
import { EXIT } from "../../src/exit-codes";
import { makeBufferIO } from "../../src/io";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { tempDir } from "../helpers/tmp";

/** `volley repo` (SPEC §4.6.21): the verbs over a fake volleyd answer, then one real round-trip. */

interface Asked {
  cmd: string;
  op: string;
  fields: Record<string, unknown>;
  admin: boolean | string;
}

/** Deps whose `ask` answers from `answer` (in order, the last repeating) and records each op. */
function fakeDeps(answers: (op: string, fields: Record<string, unknown>) => Answer | number) {
  const asked: Asked[] = [];
  let now = 0;
  const deps: RepoDeps = {
    ask: async (cmd, op, fields, _v, _env, _io, admin) => {
      asked.push({ cmd, op, fields, admin });
      return answers(op, fields) as Answer;
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    pollMs: 1000,
  };
  return { deps, asked };
}

async function run(argv: string[], deps: RepoDeps) {
  const io = makeBufferIO();
  const exitCode = await runRepo({ argv, env: {}, io }, deps);
  return { exitCode, stdout: io.readStdout(), stderr: io.readStderr() };
}

const status = (states: Record<string, string>) => ({
  ok: true,
  result: {
    repos: [
      {
        slug: "a/a",
        machines: Object.fromEntries(
          Object.entries(states).map(([m, state]) => [m, { state, reasons: [] }]),
        ),
        lines: Object.entries(states).map(([m, s]) => `${m}: ${s}`),
      },
    ],
  },
});

describe("volley repo: arguments", () => {
  it("add with --path sends repo_add as an admin op with the slug, machines and adopted paths", async () => {
    const { deps, asked } = fakeDeps(() => ({
      ok: true,
      result: {
        slug: "a/a",
        visibility: "public",
        machines: ["box"],
        status: ["box: cloning"],
      },
    }));
    const r = await run(
      ["add", "a/a", "--machine", "box", "--machine", "box", "--path", "box=/srv/a"],
      deps,
    );
    expect(r.exitCode).toBe(EXIT.OK);
    expect(asked).toEqual([
      {
        cmd: "volley repo add",
        op: "repo_add",
        fields: { slug: "a/a", machines: ["box"], paths: { box: "/srv/a" } },
        admin: "admin",
      },
    ]);
    expect(r.stdout).toBe(
      "Added a/a (public) to box.\n  box: cloning\nFollow it with: volley repo check a/a\n",
    );
  });

  it("add --path for the supervisor's machine is sent as its path; list prints it (#616)", async () => {
    const { deps, asked } = fakeDeps((op) =>
      op === "repo_list"
        ? {
            ok: true,
            result: {
              repos: [{ slug: "a/a", machines: ["box", "hub"], paths: { hub: "/src/a" } }],
            },
          }
        : {
            ok: true,
            result: {
              slug: "a/a",
              visibility: "public",
              machines: ["hub"],
              status: ["hub: ready (/src/a, adopted from wave w1)"],
            },
          },
    );
    const r = await run(["add", "a/a", "--machine", "hub", "--path", "hub=/src/a"], deps);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(asked[0]?.fields).toEqual({ slug: "a/a", machines: ["hub"], paths: { hub: "/src/a" } });
    expect(r.stdout).toContain("  hub: ready (/src/a, adopted from wave w1)\n");
    expect((await run(["list"], deps)).stdout).toBe("a/a  box, hub  adopted: hub=/src/a\n");
  });

  it("the help says --path adopts on any machine, the supervisor's included (#616)", async () => {
    const r = await run(["--help"], fakeDeps(() => ({ ok: true })).deps);
    expect(r.stdout).toContain("on any machine <name>, the\n");
    expect(r.stdout).toContain("supervisor's own included");
    expect(r.stdout).not.toContain("on paired machine <name>");
  });

  it("prints the repository's CI after Added: none, or its workflows; nothing when unread (#602)", async () => {
    const answer = (ci?: { workflows: number }) =>
      fakeDeps(() => ({
        ok: true,
        result: {
          slug: "a/a",
          visibility: "private",
          machines: ["box"],
          status: [],
          ...(ci !== undefined ? { ci } : {}),
        },
      })).deps;
    expect((await run(["add", "a/a", "--machine", "box"], answer({ workflows: 0 }))).stdout).toBe(
      "Added a/a (private) to box.\nCI: none — no GitHub Actions workflows; in a wave the two reviewers and the gate are the check\nFollow it with: volley repo check a/a\n",
    );
    expect(
      (await run(["add", "a/a", "--machine", "box"], answer({ workflows: 3 }))).stdout,
    ).toContain("Added a/a (private) to box.\nCI: 3 workflows\n");
    expect((await run(["add", "a/a", "--machine", "box"], answer())).stdout).not.toContain("CI:");
  });

  it("prints the repository block (repo_add's checks) instead of CI: when volleyd sends it (#610)", async () => {
    const { deps } = fakeDeps(() => ({
      ok: true,
      result: {
        slug: "a/a",
        visibility: "private",
        machines: ["box"],
        status: [],
        ci: { workflows: 3 },
        checks: [
          { id: "repo.exists", ok: true, severity: "block", detail: "GitHub knows it as a/a" },
          { id: "ci.mode", ok: true, severity: "warn", detail: "workflows (3)" },
        ],
      },
    }));
    expect((await run(["add", "a/a", "--machine", "box"], deps)).stdout).toBe(
      "Added a/a (private) to box.\n✓ repo.exists: GitHub knows it as a/a\n✓ ci.mode: workflows (3)\nFollow it with: volley repo check a/a\n",
    );
  });

  it("add --for-wave sends the wave with repo_add; without it no wave field (#612)", async () => {
    const { deps, asked } = fakeDeps(() => ({
      ok: true,
      result: { slug: "a/a", machines: ["box"], status: [] },
    }));
    expect((await run(["add", "a/a", "--for-wave", "hello-ab12"], deps)).exitCode).toBe(EXIT.OK);
    expect((await run(["add", "a/a"], deps)).exitCode).toBe(EXIT.OK);
    expect(asked.map((a) => a.fields)).toEqual([
      { slug: "a/a", wave: "hello-ab12" },
      { slug: "a/a" },
    ]);
    // By slug: a repository op, which the coordinator login may send too (#613).
    expect(asked.map((a) => a.admin)).toEqual(["repo", "repo"]);
  });

  it("refuses a --for-wave that is no wave id, and --for-wave on another verb", async () => {
    const { deps, asked } = fakeDeps(() => ({ ok: true }));
    for (const argv of [
      ["add", "a/a", "--for-wave", "Hello"],
      ["add", "a/a", "--for-wave", "-x"],
      ["add", "a/a", "--for-wave", ""],
      ["add", "a/a", "--for-wave", "w/1"],
      ["remove", "a/a", "--for-wave", "w1"],
      ["status", "--for-wave", "w1"],
    ]) {
      expect((await run(argv, deps)).exitCode, argv.join(" ")).toBe(EXIT.USAGE);
    }
    expect(asked).toEqual([]);
  });

  it("refuses a URL, a missing slug, a relative --path and a flag another verb owns", async () => {
    const { deps, asked } = fakeDeps(() => ({ ok: true }));
    for (const argv of [
      ["add", "https://github.com/a/a"],
      ["add"],
      ["add", "a/a", "--path", "box=srv/a"],
      ["add", "a/a", "--path", "/srv/a"],
      ["list", "--machine", "box"],
      ["status", "--wait"],
      ["check"],
      ["status", "--fix"],
      ["add", "a/a", "--release-branch", "release/x"],
      ["check", "a/a", "--path", "box=/srv/a"],
      ["remove", "a/a", "b/b"],
      ["frobnicate"],
    ]) {
      expect((await run(argv, deps)).exitCode, argv.join(" ")).toBe(EXIT.USAGE);
    }
    expect(asked).toEqual([]);
  });

  it("remove names every clone it kept, and the machines it could not tell", async () => {
    const { deps, asked } = fakeDeps(() => ({
      ok: true,
      result: {
        slug: "a/a",
        machines: ["control", "box", "b2"],
        clones: { box: "/srv/a", b2: "/srv/b2/a" },
        peers: { box: "removed", b2: "b2 is down: not told" },
      },
    }));
    const r = await run(["remove", "a/a"], deps);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(asked[0]).toMatchObject({ op: "repo_remove", fields: { slug: "a/a" }, admin: "repo" });
    expect(r.stdout).toBe(
      "Removed a/a from control, box, b2.\nClones kept (delete them by hand if you no longer want them):\n  box: /srv/a\n  b2: /srv/b2/a\n  b2: b2 is down: not told\n",
    );
  });

  it("list and status are reads (not admin ops); --json prints the answer", async () => {
    const { deps, asked } = fakeDeps((op) =>
      op === "repo_list"
        ? {
            ok: true,
            result: {
              repos: [
                { slug: "a/a", machines: "all" },
                { slug: "b/b", machines: ["box"], paths: { box: "/srv/b" } },
              ],
            },
          }
        : status({ control: "ready", box: "blocked" }),
    );
    expect((await run(["list"], deps)).stdout).toBe(
      "a/a  all machines\nb/b  box  adopted: box=/srv/b\n",
    );
    const json = await run(["status", "a/a", "--json"], deps);
    expect(JSON.parse(json.stdout)).toEqual(status({ control: "ready", box: "blocked" }).result);
    expect((await run(["status"], deps)).stdout).toBe("a/a\n  control: ready\n  box: blocked\n");
    expect(asked.map((a) => [a.op, a.admin])).toEqual([
      ["repo_list", false],
      ["repo_status", false],
      ["repo_status", false],
    ]);
    expect(asked[1]?.fields).toEqual({ slug: "a/a" });
    expect(asked[2]?.fields).toEqual({});
  });

  it("a refusal's exit code passes through", async () => {
    const { deps } = fakeDeps(() => EXIT.ERROR);
    expect((await run(["add", "a/a"], deps)).exitCode).toBe(EXIT.ERROR);
  });
});

/** A `repo_check` answer: the repository block, then box-a (no git identity) and control. */
const CHECKED = {
  ok: true,
  result: {
    slug: "o/r",
    visibility: "private",
    repository: [
      { id: "repo.exists", ok: true, severity: "block", detail: "GitHub knows it as o/r" },
      { id: "branch.release", ok: true, severity: "block", detail: "release/x exists on origin" },
      {
        id: "branch.protection",
        ok: false,
        severity: "warn",
        detail: "release/x requires 1 approving review: GitHub will refuse volleyd's merge: auto",
        fix: "set merge: manual in the wave file, or drop the rule for this branch",
      },
      { id: "ci.mode", ok: true, severity: "warn", detail: "workflows (3)" },
    ],
    machines: {
      "box-a": {
        checks: [
          { id: "repo.clone", ok: true, severity: "block", repo: "o/r", detail: "clone at /c" },
          {
            id: "git.identity",
            ok: false,
            severity: "warn",
            detail: "git has no commit identity (user.name/user.email)",
            fix: "volley setup --peer --step signin",
          },
        ],
        ready: false,
        state: "ready",
        reasons: ["git: no commit identity on box-a (volley setup --peer --step signin)"],
        from: "doctor",
        doctor_at: "2026-10-25T08:59:20.000Z",
      },
      control: {
        checks: [{ id: "repo.clone", ok: true, severity: "block", detail: "clone at /d" }],
        ready: true,
        state: "ready",
        reasons: [],
        from: "record",
        note: "a doctor run is in progress",
        doctor_at: "2026-10-25T08:48:00.000Z",
      },
      "box-b": {
        checks: [],
        ready: false,
        state: "none",
        reasons: ["no machine record from box-b yet: is its `volley peer run` service running?"],
        from: "record",
        doctor_at: null,
      },
    },
    ready_on: ["control"],
    summary:
      "not ready for a wave on box-a (git.identity), box-b (no machine record from box-b yet: is its `volley peer run` service running?); ready on control.",
  },
};

describe("volley repo check (#610)", () => {
  const at = Date.parse("2026-10-25T09:00:00.000Z");
  const checkDeps = (answer: unknown = CHECKED) => {
    const f = fakeDeps(() => answer as Answer);
    f.deps.now = () => at;
    return f;
  };

  it("asks repo_check as a read with the slug and release branch; prints each block and the closing line; exit 1 while a machine is not ready", async () => {
    const { deps, asked } = checkDeps();
    const r = await run(["check", "o/r", "--release-branch", "release/x"], deps);
    expect(asked).toEqual([
      {
        cmd: "volley repo check",
        op: "repo_check",
        fields: { slug: "o/r", release_branch: "release/x" },
        admin: false,
      },
    ]);
    expect(r.stdout).toBe(
      [
        "o/r (private)",
        "✓ repo.exists: GitHub knows it as o/r",
        "✓ branch.release: release/x exists on origin",
        "! branch.protection: release/x requires 1 approving review: GitHub will refuse volleyd's merge: auto",
        "    fix: set merge: manual in the wave file, or drop the rule for this branch",
        "✓ ci.mode: workflows (3)",
        "",
        "box-a (doctor 40 s ago)",
        "✓ repo.clone: clone at /c",
        "! git.identity: git has no commit identity (user.name/user.email)",
        "    fix: volley setup --peer --step signin",
        "1 warning(s) still keep this machine from being ready for agents (the supervisor needs them): git.identity",
        "",
        "control (last report 12 min ago; a doctor run is in progress)",
        "✓ repo.clone: clone at /d",
        "",
        "box-b (no machine record)",
        "  no machine record from box-b yet: is its `volley peer run` service running?",
        "",
        "not ready for a wave on box-a (git.identity), box-b (no machine record from box-b yet: is its `volley peer run` service running?); ready on control.",
        "",
      ].join("\n"),
    );
    expect(r.exitCode).toBe(EXIT.ERROR);
  });

  it("exit 0 when every machine asked is ready; --machine narrows; --json prints the answer", async () => {
    const ready = {
      ok: true,
      result: {
        ...CHECKED.result,
        machines: { control: CHECKED.result.machines.control },
        ready_on: ["control"],
        summary: "ready for a wave on: control.",
      },
    };
    const { deps, asked } = checkDeps(ready);
    const r = await run(["check", "o/r", "--machine", "control"], deps);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stdout.endsWith("ready for a wave on: control.\n")).toBe(true);
    expect(asked[0]?.fields).toEqual({ slug: "o/r", machines: ["control"] });
    const json = await run(["check", "o/r", "--json"], deps);
    expect(JSON.parse(json.stdout)).toEqual(ready.result);
    expect(json.exitCode).toBe(EXIT.OK);
  });

  it("--fix asks as an admin with fix: true", async () => {
    const { deps, asked } = checkDeps();
    await run(["check", "o/r", "--fix"], deps);
    expect(asked[0]).toMatchObject({
      op: "repo_check",
      fields: { slug: "o/r", fix: true },
      admin: true,
    });
  });

  it("a failing repository line (not on GitHub) exits 1 whatever the machines say", async () => {
    const { deps } = checkDeps({
      ok: true,
      result: {
        slug: "o/r",
        repository: [
          {
            id: "repo.exists",
            ok: false,
            severity: "block",
            detail: "gh repo view o/r: not found",
          },
        ],
        machines: { control: CHECKED.result.machines.control },
        ready_on: ["control"],
        summary: "ready for a wave on: control.",
      },
    });
    expect((await run(["check", "o/r"], deps)).exitCode).toBe(EXIT.ERROR);
  });
});

describe("volley repo add --wait", () => {
  const added = { ok: true, result: { slug: "a/a", machines: ["control", "box"], status: [] } };

  it("polls repo_status until every machine is ready: exit 0, each line printed once", async () => {
    const seq = [
      status({ control: "ready", box: "cloning" }),
      status({ control: "ready", box: "cloning" }),
      status({ control: "ready", box: "ready" }),
    ];
    const { deps, asked } = fakeDeps((op) => (op === "repo_add" ? added : (seq.shift() ?? added)));
    const r = await run(["add", "a/a", "--wait"], deps);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(asked.filter((a) => a.op === "repo_status")).toHaveLength(3);
    expect(r.stdout).toBe(
      "Added a/a to control, box.\n  control: ready\n  box: cloning\n  box: ready\n",
    );
  });

  it("once settled, asks repo_check once and ends on its machine blocks and closing line (#610)", async () => {
    const { deps, asked } = fakeDeps((op) =>
      op === "repo_add"
        ? added
        : op === "repo_check"
          ? CHECKED
          : status({ control: "ready", "box-a": "ready" }),
    );
    deps.now = () => Date.parse("2026-10-25T09:00:00.000Z");
    const r = await run(["add", "a/a", "--wait"], deps);
    expect(asked.filter((a) => a.op === "repo_check")).toEqual([
      { cmd: "volley repo add", op: "repo_check", fields: { slug: "a/a" }, admin: false },
    ]);
    expect(r.stdout).toContain("\nbox-a (doctor 40 s ago)\n✓ repo.clone: clone at /c\n");
    expect(r.stdout).not.toContain("✓ repo.exists");
    expect(r.stdout.endsWith("ready on control.\n")).toBe(true);
    // The wait's exit code: every machine settled ready.
    expect(r.exitCode).toBe(EXIT.OK);
  });

  it("a machine that ends blocked exits 1", async () => {
    const { deps } = fakeDeps((op) =>
      op === "repo_add" ? added : status({ control: "ready", box: "blocked" }),
    );
    expect((await run(["add", "a/a", "--wait"], deps)).exitCode).toBe(EXIT.ERROR);
  });

  it("gives up after --wait-timeout: exit 124", async () => {
    const { deps } = fakeDeps((op) =>
      op === "repo_add" ? added : status({ control: "ready", box: "cloning" }),
    );
    const r = await run(["add", "a/a", "--wait", "--wait-timeout", "5"], deps);
    expect(r.exitCode).toBe(EXIT.TIMEOUT);
    expect(r.stderr).toContain("not every machine settled within 5 s");
  });
});

describe("volley repo over the broker", () => {
  let tb: TestBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
  });
  afterEach(async () => {
    await tb.close();
  });

  it("add goes to the admin's account-op topic and reads volleyd's answer", async () => {
    const b = new VolleyBroker();
    await b.connect({ url: tb.url, agentId: "volleyd" });
    const env = (channel: string, type: string, payload: unknown, correlationId?: string) =>
      JSON.stringify(
        buildEnvelope({
          agentId: "volleyd",
          parentId: null,
          channel,
          type,
          payload,
          ...(correlationId !== undefined ? { correlationId } : {}),
        }),
      );
    await b.publish("volley/test/volleyd/status", env("status", "working", {}), {
      qos: 1,
      retain: true,
    });
    const topics: string[] = [];
    await b.subscribeStream("volley/_system/auth/ops/+", ({ topic, payload }) => {
      const q = parseEnvelope(payload);
      if (q?.type !== "query" || q.correlation_id === null) return;
      topics.push(topic);
      const p = q.payload as Record<string, unknown>;
      void b.publish(
        `volley/_system/auth/replies/${q.correlation_id}`,
        env(
          "_system/auth",
          "ack",
          {
            text: "ACKED",
            acked_type: "query",
            op: p.op,
            ok: true,
            result: { slug: p.slug, machines: ["box"], status: ["box: cloning"] },
          },
          q.correlation_id,
        ),
        { qos: 1, retain: false },
      );
    });
    const io = makeBufferIO();
    const code = await runRepo(
      {
        argv: ["add", "a/a", "--machine", "box"],
        env: {
          VOLLEY_BROKER_URL: tb.url,
          VOLLEY_NAMESPACE: "test",
          VOLLEY_AUTH_USERNAME: "admin-1",
          VOLLEY_AUTH_PASSWORD: "pw",
        },
        io,
      },
      realRepoDeps(),
    );
    await b.disconnect();
    expect(io.readStderr()).toBe("");
    expect(code).toBe(EXIT.OK);
    expect(topics).toEqual(["volley/_system/auth/ops/admin-1"]);
    expect(io.readStdout()).toContain("Added a/a to box.");
  });

  describe("with the coordinator login `volley setup` saved, no VOLLEY_AUTH_* (#613)", () => {
    const cwd = process.cwd();
    let plain: string;
    beforeEach(() => {
      // A plain directory: no agent identity file above it (this repo may run inside a worktree).
      plain = tempDir("volley-repo-coord-");
      process.chdir(plain);
      useSavedLogin({
        platform: "linux",
        keychain: () => null,
        coordinatorFile: () => ({ username: "coordinator", password: "c-pw" }),
      });
    });
    afterEach(() => {
      useSavedLogin(null);
      process.chdir(cwd);
    });

    /** A volleyd answering every account op, recording the topics it was asked on. */
    const answering = async () => {
      const b = new VolleyBroker();
      await b.connect({ url: tb.url, agentId: "volleyd" });
      const envelope = (channel: string, type: string, payload: unknown, cid?: string) =>
        JSON.stringify(
          buildEnvelope({
            agentId: "volleyd",
            parentId: null,
            channel,
            type,
            payload,
            ...(cid !== undefined ? { correlationId: cid } : {}),
          }),
        );
      await b.publish("volley/test/volleyd/status", envelope("status", "working", {}), {
        qos: 1,
        retain: true,
      });
      const topics: string[] = [];
      await b.subscribeStream("volley/_system/auth/ops/+", ({ topic, payload }) => {
        const q = parseEnvelope(payload);
        if (q?.type !== "query" || q.correlation_id === null) return;
        topics.push(topic);
        const p = q.payload as Record<string, unknown>;
        void b.publish(
          `volley/_system/auth/replies/${q.correlation_id}`,
          envelope(
            "_system/auth",
            "ack",
            {
              text: "ACKED",
              acked_type: "query",
              op: p.op,
              ok: true,
              result: { slug: p.slug, machines: ["box"], status: [] },
            },
            q.correlation_id,
          ),
          { qos: 1, retain: false },
        );
      });
      return { b, topics };
    };

    it("add by slug goes out on ops/coordinator and prints Added", async () => {
      const { b, topics } = await answering();
      const io = makeBufferIO();
      const code = await runRepo(
        {
          argv: ["add", "a/a"],
          env: { VOLLEY_BROKER_URL: tb.url, VOLLEY_NAMESPACE: "test", HOME: plain },
          io,
        },
        realRepoDeps(),
      );
      await b.disconnect();
      expect(io.readStderr()).toBe("");
      expect(code).toBe(EXIT.OK);
      expect(topics).toEqual(["volley/_system/auth/ops/coordinator"]);
      expect(io.readStdout()).toContain("Added a/a to box.");
    });

    it("add --path is refused at once: adopting a clone is an admin's", async () => {
      const { b, topics } = await answering();
      const io = makeBufferIO();
      const code = await runRepo(
        {
          argv: ["add", "a/a", "--machine", "box", "--path", "box=/srv/a"],
          env: { VOLLEY_BROKER_URL: tb.url, VOLLEY_NAMESPACE: "test", HOME: plain },
          io,
        },
        realRepoDeps(),
      );
      await b.disconnect();
      expect(code).toBe(EXIT.USAGE);
      expect(io.readStderr()).toContain("coordinator is a fixed identity");
      expect(io.readStderr()).toContain("adopting a clone at a path (--path) is an admin's");
      expect(io.readStderr()).not.toContain("VOLLEY_AUTH_PASSWORD");
      expect(topics).toEqual([]);
    });
  });
});
