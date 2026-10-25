import { describe, expect, it, vi } from "vitest";
import { CREDENTIALS_STORAGE_KEY } from "../src/store/context";
import {
  type ReplyKey,
  accountsRequired,
  createAuthOps,
  listenerProbes,
  parseSetupApplied,
  parseSetupPlan,
  readSessionRole,
  redeemToken,
} from "../src/store/control";
import type { TokenClient } from "../src/store/mqtt-client";
import { createPeerOps } from "../src/store/peerOps";
import type { DeskMessage, Envelope } from "../src/store/types";
import { fakeOps as fakeAuthOps } from "./helpers/auth-ops";

/** A fake reply key whose "sealed" text is the JSON itself. */
const plainKey = async (): Promise<ReplyKey> => ({
  jwk: { kty: "RSA", n: "n", e: "AQAB" },
  open: async (sealed) => JSON.parse(sealed) as Record<string, unknown>,
});

function mockClient() {
  const published: { topic: string; envelope: Envelope }[] = [];
  const handlers = new Set<(m: DeskMessage) => void>();
  return {
    published,
    handlers,
    client: {
      publish: vi.fn(async (topic: string, payload: string) => {
        published.push({ topic, envelope: JSON.parse(payload) as Envelope });
      }),
      onMessage: (h: (m: DeskMessage) => void) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
    },
    answer(correlationId: string, payload: Record<string, unknown>) {
      const topic = `volley/_system/auth/replies/${correlationId}`;
      const envelope = {
        schema_version: "0.1",
        agent_id: "volleyd",
        parent_id: null,
        channel: "_system/auth",
        type: "ack",
        wall_time: "2026-10-19T12:00:00.000Z",
        correlation_id: correlationId,
        payload,
      } as Envelope;
      for (const h of [...handlers]) h({ topic, envelope } as DeskMessage);
    },
  };
}

describe("createAuthOps", () => {
  it("hands a late answer, its sealed token opened, to onLate instead of dropping it", async () => {
    vi.useFakeTimers();
    try {
      const m = mockClient();
      const ops = createAuthOps(m.client, { identity: "admin-0123abcd", replyKey: plainKey });
      const onLate = vi.fn();
      const pending = ops.request("setup_apply", { step: "accounts" }, { timeoutMs: 100, onLate });
      await vi.advanceTimersByTimeAsync(150);
      expect(await pending).toMatchObject({ ok: false, unanswered: true });
      const cid = m.published[0]?.envelope.correlation_id as string;
      m.answer(cid, {
        ok: true,
        result: { lines: [], problems: [] },
        sealed: JSON.stringify({ token: "vly_admin_x" }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(onLate).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, secret: { token: "vly_admin_x" } }),
      );
      // Delivered once; the listener is gone afterwards.
      expect(m.handlers.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops listening at the timeout when nobody takes a late answer", async () => {
    vi.useFakeTimers();
    try {
      const m = mockClient();
      const ops = createAuthOps(m.client, { identity: "admin-0123abcd", replyKey: plainKey });
      const pending = ops.request("account_list", {}, { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(150);
      await pending;
      expect(m.handlers.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readSessionRole", () => {
  const storage = (v: unknown) => ({
    getItem: (k: string) => (k === CREDENTIALS_STORAGE_KEY ? JSON.stringify(v) : null),
  });

  it("is the stored role only for the account actually in use", () => {
    const s = storage({ username: "admin-0123abcd", password: "pw", role: "admin" });
    expect(readSessionRole("admin-0123abcd", s)).toBe("admin");
    // Build-time credentials (`desk`) win over the stored admin sign-in: not an admin session.
    expect(readSessionRole("desk", s)).toBeNull();
    expect(readSessionRole(null, s)).toBeNull();
  });
});

describe("redeemToken", () => {
  it("records no role when volleyd's answer does not say (a link may grant watch)", async () => {
    const handlers = new Set<(t: string, p: string) => void>();
    const client: TokenClient = {
      connect: async () => {},
      subscribe: async () => {},
      publish: async (_topic, payload) => {
        const env = JSON.parse(payload) as Envelope;
        const answer = {
          agent_id: "volleyd",
          type: "ack",
          correlation_id: env.correlation_id,
          payload: { ok: true, sealed: JSON.stringify({ username: "w-1", password: "pw" }) },
        };
        for (const h of handlers) h("volley-auth/redeem/0123abcd/reply", JSON.stringify(answer));
      },
      onMessage: (h) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      end: async () => {},
    };
    const r = await redeemToken({
      url: "ws://broker.test:9001",
      token: "vly_signin_0123abcd_0123456789abcdef0123456789abcdef",
      label: "Desk on TV",
      connect: () => client,
      replyKey: plainKey,
    });
    expect(r).toEqual({
      ok: true,
      username: "w-1",
      password: "pw",
      role: null,
      label: "Desk on TV",
    });
  });
});

describe("the setup-op contract", () => {
  it("parses plan_id, the security step's LAN state, terminal-only changes and broker facts", () => {
    const plan = parseSetupPlan({
      steps: [
        {
          step: "security",
          title: "Security",
          found: [],
          changes: [
            {
              summary: "Restart the broker (sudo systemctl restart mosquitto)",
              terminal: {
                reason: "it needs sudo",
                command: "sudo volley setup --step security --lan",
              },
            },
          ],
          plan_id: "sec-1",
          lan: { planned: true, current: false },
        },
      ],
      broker: {
        accounts_required: true,
        listeners: [
          { port: 1883, anonymous: "refused" },
          { port: 9001, anonymous: "refused" },
        ],
      },
    });
    expect(plan?.steps[0]).toMatchObject({
      plan_id: "sec-1",
      lan: { planned: true, current: false },
      changes: [{ terminal: { command: "sudo volley setup --step security --lan" } }],
    });
    expect(plan && accountsRequired(plan)).toBe(true);
  });

  it("parses the network step and its kind, in setup's order after accounts", () => {
    const plan = parseSetupPlan({
      steps: [
        { step: "services", title: "Services", found: [], changes: [] },
        {
          step: "network",
          title: "Network",
          found: [],
          changes: [{ summary: "Record that this machine is reached on its own network only" }],
          plan_id: "network-1",
          network: { planned: "none", current: "tailscale" },
        },
        { step: "accounts", title: "Accounts", found: [], changes: [] },
      ],
    });
    expect(plan?.steps.map((s) => s.step)).toEqual(["accounts", "network", "services"]);
    expect(plan?.steps[1]?.network).toEqual({ planned: "none", current: "tailscale" });
    const odd = parseSetupPlan({
      steps: [
        {
          step: "network",
          title: "Network",
          found: [],
          changes: [],
          network: { planned: "funnel" },
        },
      ],
    });
    expect(odd?.steps[0]?.network).toBeUndefined();
  });

  it("parses a step's notes (what volleyd cannot check), and leaves them out when none", () => {
    const plan = parseSetupPlan({
      steps: [
        {
          step: "accounts",
          title: "Accounts",
          found: ["The 5 shared roles match this Volley"],
          notes: ["The macOS keychain can't be checked from the Desk", ""],
          changes: [],
        },
        { step: "services", title: "Services", found: [], changes: [] },
      ],
    });
    expect(plan?.steps[0]?.notes).toEqual(["The macOS keychain can't be checked from the Desk"]);
    expect(plan?.steps[1]).not.toHaveProperty("notes");
  });

  it("reads accounts-required from the listeners' probes, not from pending changes", () => {
    const plan = parseSetupPlan({
      steps: [
        {
          step: "detect",
          title: "Broker",
          found: [
            "Listener 1883: refuses anonymous clients",
            "Listener 9001: refuses anonymous clients",
          ],
          changes: [],
        },
        // A pending security change (a LAN toggle) does not mean accounts are off.
        { step: "security", title: "Security", found: [], changes: [{ summary: "Write it" }] },
      ],
    });
    if (plan === null) throw new Error("no plan");
    expect(accountsRequired(plan)).toBe(true);
    expect(listenerProbes(plan)).toEqual([
      { port: 1883, anonymous: "refused" },
      { port: 9001, anonymous: "refused" },
    ]);
    const open = parseSetupPlan({
      steps: [
        {
          step: "detect",
          title: "Broker",
          found: ["Listener 1883: accepts anonymous clients", "Listener 9001: not listening"],
          changes: [],
        },
      ],
    });
    expect(open && accountsRequired(open)).toBe(false);
    expect(open && listenerProbes(open)[1]).toEqual({ port: 9001, anonymous: "unreachable" });
  });

  it("parses the apply report's terminal leftovers and restart notice", () => {
    expect(
      parseSetupApplied({
        ok: true,
        result: {
          lines: ["Wrote mosquitto.conf."],
          problems: [],
          terminal: [{ summary: "Install volleyd", reason: "r", command: "volley setup" }],
          restarting: true,
        },
      }),
    ).toEqual({
      lines: ["Wrote mosquitto.conf."],
      problems: [],
      terminal: [{ summary: "Install volleyd", reason: "r", command: "volley setup" }],
      restarting: true,
    });
  });
});

describe("the repository ops (SPEC §4.6.21)", () => {
  it("repoAdd sends repo_add { slug, machines, paths } and returns volleyd's canonical answer", async () => {
    const { ops, calls } = fakeAuthOps({
      repo_add: () => ({
        ok: true,
        result: {
          slug: "Example-Org/example-repo",
          url: "https://github.com/Example-Org/example-repo",
          visibility: "private",
          machines: ["hub", "box-a"],
          status: ["hub: cloning (/path/to/repos/Example-Org/example-repo)"],
        },
      }),
    });
    const peer = createPeerOps(ops, { role: "admin" });
    await expect(
      peer.repoAdd("example-org/example-repo", {
        machines: ["hub", "box-a"],
        paths: { "box-a": "/srv/work/example-repo" },
      }),
    ).resolves.toEqual({
      ok: true,
      slug: "Example-Org/example-repo",
      url: "https://github.com/Example-Org/example-repo",
      visibility: "private",
      machines: ["hub", "box-a"],
      status: ["hub: cloning (/path/to/repos/Example-Org/example-repo)"],
    });
    expect(calls[0]).toMatchObject({
      op: "repo_add",
      fields: {
        slug: "example-org/example-repo",
        machines: ["hub", "box-a"],
        paths: { "box-a": "/srv/work/example-repo" },
      },
    });
    // No machines: volleyd's default, every machine; no paths: none sent.
    await peer.repoAdd("example-org/other");
    expect(calls[1]?.fields).toEqual({ slug: "example-org/other", machines: "all" });
  });

  it("a refused repo_add carries volleyd's reason (gh's, for a repository GitHub does not know)", async () => {
    const { ops } = fakeAuthOps({
      repo_add: () => ({ ok: false, error: "GraphQL: Could not resolve to a Repository" }),
    });
    await expect(createPeerOps(ops).repoAdd("example-org/nope")).resolves.toEqual({
      ok: false,
      error: "GraphQL: Could not resolve to a Repository",
    });
  });

  it("repoRemove sends repo_remove and returns the clone paths left on disk", async () => {
    const { ops, calls } = fakeAuthOps({
      repo_remove: () => ({
        ok: true,
        result: {
          slug: "example-org/example-repo",
          machines: ["box-a"],
          clones: { "box-a": "/srv/work/example-repo" },
          peers: { "box-a": "removed" },
        },
      }),
    });
    const peer = createPeerOps(ops);
    await expect(peer.repoRemove("example-org/example-repo")).resolves.toEqual({
      ok: true,
      slug: "example-org/example-repo",
      machines: ["box-a"],
      clones: { "box-a": "/srv/work/example-repo" },
      peers: { "box-a": "removed" },
    });
    expect(calls[0]).toMatchObject({
      op: "repo_remove",
      fields: { slug: "example-org/example-repo" },
    });
    await peer.repoRemove("example-org/example-repo", ["box-a"]);
    expect(calls[1]?.fields).toEqual({ slug: "example-org/example-repo", machines: ["box-a"] });
  });

  it("repoList and repoStatus read the configured repositories and where each stands", async () => {
    const { ops, calls } = fakeAuthOps({
      repo_list: () => ({
        ok: true,
        result: { repos: [{ slug: "example-org/example-repo", machines: "all" }] },
      }),
      repo_status: () => ({
        ok: true,
        result: {
          repos: [
            {
              slug: "example-org/example-repo",
              machines: { "box-a": { state: "ready", path: "/srv/r", reasons: [] } },
              lines: ["box-a: ready (/srv/r)"],
            },
          ],
        },
      }),
    });
    const peer = createPeerOps(ops);
    await expect(peer.repoList()).resolves.toEqual({
      ok: true,
      repos: [{ slug: "example-org/example-repo", machines: "all" }],
    });
    await expect(peer.repoStatus("example-org/example-repo")).resolves.toEqual({
      ok: true,
      repos: [
        {
          slug: "example-org/example-repo",
          machines: { "box-a": { state: "ready", path: "/srv/r", reasons: [] } },
          lines: ["box-a: ready (/srv/r)"],
        },
      ],
    });
    expect(calls.map((c) => [c.op, c.fields])).toEqual([
      ["repo_list", {}],
      ["repo_status", { slug: "example-org/example-repo" }],
    ]);
  });

  it("Repair's per-repository clone rides peer_doctor's repos_add", async () => {
    const { ops, calls } = fakeAuthOps({
      peer_doctor: () => ({ ok: true, result: { checks: [], plan: [] } }),
    });
    await createPeerOps(ops).doctor("box-a", {
      fix: true,
      clone: true,
      reposAdd: ["example-org/example-repo", "example-org/lib=/srv/lib"],
    });
    expect(calls[0]?.fields).toEqual({
      name: "box-a",
      fix: true,
      clone: true,
      repos_add: ["example-org/example-repo", "example-org/lib=/srv/lib"],
    });
  });
});
