import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import type { Answer } from "../../src/commands/peer";
import { type RepoDeps, realRepoDeps, runRepo } from "../../src/commands/repo";
import { EXIT } from "../../src/exit-codes";
import { makeBufferIO } from "../../src/io";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";

/** `volley repo` (SPEC §4.6.21): the verbs over a fake volleyd answer, then one real round-trip. */

interface Asked {
  cmd: string;
  op: string;
  fields: Record<string, unknown>;
  admin: boolean;
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
  it("add sends repo_add as an admin op with the slug, machines and adopted paths", async () => {
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
        admin: true,
      },
    ]);
    expect(r.stdout).toBe(
      "Added a/a (public) to box.\n  box: cloning\nFollow it with: volley repo status a/a\n",
    );
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
    expect(asked[0]).toMatchObject({ op: "repo_remove", fields: { slug: "a/a" }, admin: true });
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
});
