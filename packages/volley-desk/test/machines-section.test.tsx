import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Machines, type MachinesProps, sshHost } from "../src/settings/Machines";
import { DESK_SUBSCRIPTIONS } from "../src/store/mqtt-client";
import { type PeerOps, createPeerOps, joinCommand } from "../src/store/peerOps";
import { initialState, reduceAll, resync } from "../src/store/reducer";
import type { DeskMessage, Envelope, MachinePayload } from "../src/store/types";

const NOW = Date.parse("2026-10-19T09:30:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const boxA: MachinePayload = {
  name: "box-a",
  os: "linux",
  arch: "x64",
  cores: 16,
  tunnel: "up",
  load: [1.25, 0.9, 0.7],
  agents: 3,
  remote_port: 21883,
  last_seen: iso(NOW - 20_000),
};

const boxB: MachinePayload = {
  name: "box-b",
  os: "darwin",
  cores: 8,
  tunnel: "down",
  reason: "heartbeat_timeout",
  load: [0.4, 0.3, 0.2],
  agents: 0,
  last_seen: iso(NOW - 5 * 60_000),
};

const boxC: MachinePayload = {
  name: "box-c",
  os: "linux",
  cores: 4,
  tunnel: "up",
  load: [0.1, 0.1, 0.1],
  agents: 0,
  last_seen: iso(NOW),
};

function machineMsg(p: MachinePayload | null, name = p?.name ?? "", agentId = name): DeskMessage {
  return {
    topic: `volley/_system/machines/${name}`,
    envelope:
      p === null
        ? null
        : {
            schema_version: "0.1",
            agent_id: agentId,
            channel: "_system/machines",
            type: "machine",
            wall_time: iso(NOW),
            payload: p,
          },
    receivedAt: NOW,
    retained: true,
  };
}

describe("reducer: the machines slice", () => {
  it("keeps one retained record per machine and forgets a cleared one (peer_remove)", () => {
    const s = reduceAll(initialState(), [machineMsg(boxA), machineMsg(boxB)]);
    expect(Object.keys(s.machines ?? {})).toEqual(["box-a", "box-b"]);
    expect(s.machines?.["box-a"]).toEqual(boxA);
    const cleared = reduceAll(s, [machineMsg(null, "box-a")]);
    expect(Object.keys(cleared.machines ?? {})).toEqual(["box-b"]);
  });

  it("takes volleyd's own down record for a machine, but nobody else's", () => {
    const down = { ...boxA, tunnel: "down" as const, reason: "heartbeat_timeout" as const };
    let s = reduceAll(initialState(), [machineMsg(boxA), machineMsg(down, "box-a", "volleyd")]);
    expect(s.machines?.["box-a"]?.tunnel).toBe("down");
    s = reduceAll(s, [machineMsg({ ...boxA, agents: 99 }, "box-a", "box-b")]);
    expect(s.machines?.["box-a"]?.agents).toBe(3);
  });

  it("drops a record whose name is not its topic's or that is not a machine record", () => {
    const s = reduceAll(initialState(), [
      machineMsg({ ...boxA, name: "box-z" }, "box-a", "box-a"),
      { ...machineMsg(boxC), envelope: { ...(machineMsg(boxC).envelope as Envelope), type: "x" } },
    ]);
    expect(s.machines ?? {}).toEqual({});
  });

  it("is retained state: a reconnect resync forgets it until the replay", () => {
    const s = resync(reduceAll(initialState(), [machineMsg(boxA)]));
    expect(s.machines).toEqual({});
  });

  it("the Desk subscribes to the machine records and the account-op answers", () => {
    expect(DESK_SUBSCRIPTIONS).toContain("volley/_system/machines/+");
    expect(DESK_SUBSCRIPTIONS).toContain("volley/_system/auth/replies/+");
  });
});

// ------------------------------------------------------------- the op client

/** A SteerClient stand-in: records publishes, delivers what the test plays as volleyd. */
function fakeClient() {
  const handlers = new Set<(m: DeskMessage) => void>();
  const published: { topic: string; env: Envelope }[] = [];
  return {
    published,
    publish: vi.fn(async (topic: string, payload: string) => {
      published.push({ topic, env: JSON.parse(payload) as Envelope });
    }),
    onMessage(h: (m: DeskMessage) => void) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    /** Answer the last request as `from` (volleyd by default). */
    answer(payload: Record<string, unknown>, from = "volleyd") {
      const req = published.at(-1)?.env as Envelope;
      const msg: DeskMessage = {
        topic: `volley/_system/auth/replies/${req.correlation_id}`,
        envelope: {
          schema_version: "0.1",
          agent_id: from,
          channel: "_system/auth",
          type: "ack",
          wall_time: iso(NOW),
          correlation_id: req.correlation_id as string,
          payload: { text: "ACKED", acked_type: "query", ...payload },
        },
        receivedAt: NOW,
      };
      for (const h of handlers) h(msg);
    },
  };
}

/** Seal `secret` to the request's reply_key exactly as volleyd does (accounts.ts `seal`). */
function sealTo(req: Envelope, secret: Record<string, unknown>): string {
  const jwk = (req.payload as { reply_key: unknown }).reply_key;
  const key = createPublicKey({ key: jwk as never, format: "jwk" });
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(JSON.stringify(secret)),
  ).toString("base64url");
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Wait until the client has published `n` requests (key generation is async). */
async function published(c: ReturnType<typeof fakeClient>, n: number) {
  for (let i = 0; i < 200 && c.published.length < n; i++) await flush();
  expect(c.published.length).toBe(n);
  return c.published[n - 1] as { topic: string; env: Envelope };
}

describe("peer ops: admin requests on the Desk's own account-op topic", () => {
  it("peer_invite goes to volley/_system/auth/ops/<identity> with a reply_key; the sealed code is opened", async () => {
    const c = fakeClient();
    const ops = createPeerOps(c, { identity: "owner-desk" });
    const pending = ops.invite();
    const req = await published(c, 1);
    expect(req.topic).toBe("volley/_system/auth/ops/owner-desk");
    expect(req.env).toMatchObject({
      agent_id: "owner-desk",
      channel: "_system/auth",
      type: "query",
      payload: { op: "peer_invite" },
    });
    expect(req.env.correlation_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const key = (req.env.payload as { reply_key: Record<string, unknown> }).reply_key;
    expect(Object.keys(key).sort()).toEqual(["e", "kty", "n"]);
    // A forged answer from anyone but volleyd is ignored.
    c.answer(
      { op: "peer_invite", ok: true, sealed: sealTo(req.env, { code: "XXXX-XXXX" }) },
      "box-a",
    );
    const expires = iso(NOW + 600_000);
    c.answer({
      op: "peer_invite",
      ok: true,
      result: { expires_at: expires, ttl_s: 600 },
      sealed: sealTo(req.env, { code: "MXQ4-7KDP" }),
    });
    await expect(pending).resolves.toEqual({ ok: true, code: "MXQ4-7KDP", expiresAt: expires });
  });

  it("a refused invite, and one whose answer carries no code, say why", async () => {
    const c = fakeClient();
    const ops = createPeerOps(c, { identity: "owner-desk" });
    const refused = ops.invite();
    await published(c, 1);
    c.answer({ op: "peer_invite", ok: false, error: "owner-desk is not an admin account" });
    await expect(refused).resolves.toEqual({
      ok: false,
      error: "owner-desk is not an admin account",
    });
    const empty = ops.invite();
    await published(c, 2);
    c.answer({ op: "peer_invite", ok: true, result: {} });
    await expect(empty).resolves.toMatchObject({ ok: false, error: /no pairing code/ });
  });

  it("peer_remove sends the name and resolves with volleyd's answer", async () => {
    const c = fakeClient();
    const ops = createPeerOps(c, { identity: "owner-desk" });
    const r = ops.remove("box-a");
    const req = await published(c, 1);
    expect(req.env.payload).toEqual({ op: "peer_remove", name: "box-a" });
    c.answer({ op: "peer_remove", ok: true, result: { revoked: true, host_removed: true } });
    await expect(r).resolves.toEqual({ ok: true });
  });

  it("admin(): an answered account_list proves an admin; no answer means not one; it asks once", async () => {
    const c = fakeClient();
    const ops = createPeerOps(c, { identity: "owner-desk" });
    const yes = ops.admin();
    const req = await published(c, 1);
    expect(req.env.payload).toEqual({ op: "account_list" });
    c.answer({ op: "account_list", ok: true, result: { accounts: [] } });
    await expect(yes).resolves.toBe(true);
    await expect(ops.admin()).resolves.toBe(true);
    expect(c.published).toHaveLength(1);

    // The broker drops a non-admin's publish to the topic: nothing ever answers.
    const quiet = fakeClient();
    await expect(
      createPeerOps(quiet, { identity: "watcher", timeoutMs: 20 }).admin(),
    ).resolves.toBe(false);
    const refusing = fakeClient();
    const no = createPeerOps(refusing, { identity: "watcher" }).admin();
    await published(refusing, 1);
    refusing.answer({ op: "account_list", ok: false, error: "watcher is not an admin account" });
    await expect(no).resolves.toBe(false);
  });

  it("the join command names the code and the ssh destination", () => {
    expect(joinCommand("MXQ4-7KDP", "owner@hub.local")).toBe(
      "volley peer join MXQ4-7KDP --to owner@hub.local",
    );
    expect(joinCommand("MXQ4-7KDP", "")).toBe(
      "volley peer join MXQ4-7KDP --to <you>@<this-machine>",
    );
  });
});

// ------------------------------------------------------------------ the section

function fakeOps(over: Partial<PeerOps> = {}) {
  return {
    admin: vi.fn(async () => true),
    invite: vi.fn(async () => ({
      ok: true as const,
      code: "MXQ4-7KDP",
      expiresAt: iso(NOW + 600_000),
    })),
    remove: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}

function setup(props: Partial<MachinesProps> = {}) {
  const ops = fakeOps();
  const base: MachinesProps = {
    machines: { "box-a": boxA, "box-b": boxB },
    hubUp: true,
    ops,
    now: NOW,
    host: "owner@hub.local",
    ...props,
  };
  const r = render(<Machines {...base} />);
  const rerender = (more: Partial<MachinesProps>) => r.rerender(<Machines {...base} {...more} />);
  return { ...r, ops: (props.ops as ReturnType<typeof fakeOps>) ?? ops, rerender };
}

const card = (name: string) => screen.getByRole("article", { name });
/** The join command as shown (its flags are wrapped so they never break at a hyphen). */
const command = (text: string) =>
  screen.getByText((_, el) => el?.tagName === "CODE" && el.textContent === text);

describe("Settings › Machines", () => {
  it("two retained machine records render two cards with their health, beside this machine", async () => {
    setup();
    await act(flush);
    const a = within(card("box-a"));
    expect(a.getByText("linux x64 · 16 cores")).toBeInTheDocument();
    expect(a.getByText("tunnel up")).toBeInTheDocument();
    expect(a.getByText("load 1.25")).toBeInTheDocument();
    expect(a.getByText("3 agents")).toBeInTheDocument();
    expect(a.getByText(/seen 20s ago/)).toBeInTheDocument();
    const b = within(card("box-b"));
    expect(b.getByText("darwin · 8 cores")).toBeInTheDocument();
    expect(b.getByText("tunnel down")).toHaveClass("hb", "hb--stale");
    expect(b.getByText(/no heartbeat · last seen 5m ago/)).toBeInTheDocument();
    expect(b.getByText(/new agents for it wait/i)).toBeInTheDocument();
    const hub = within(card("This machine"));
    expect(hub.getByText("this one")).toBeInTheDocument();
    expect(hub.getByText("local")).toBeInTheDocument();
    expect(hub.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("Add a machine → Create pairing code calls peer_invite and shows the command with a countdown", async () => {
    const { ops } = setup();
    await act(flush);
    fireEvent.click(screen.getByRole("button", { name: "+ Add a machine" }));
    // It says what it will do before it does it.
    expect(screen.getByText(/one-time pairing code/i)).toBeInTheDocument();
    expect(ops.invite).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
    });
    expect(ops.invite).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Run this on the other machine")).toBeInTheDocument();
    expect(command("volley peer join MXQ4-7KDP --to owner@hub.local")).toBeInTheDocument();
    expect(screen.getByText("10:00")).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the machine to join/)).toBeInTheDocument();
    // The ssh destination is editable and the command follows it.
    fireEvent.change(screen.getByLabelText("This machine's ssh address"), {
      target: { value: "me@hub" },
    });
    expect(command("volley peer join MXQ4-7KDP --to me@hub")).toBeInTheDocument();
  });

  it("the countdown runs out into an expired code that offers a new one", async () => {
    const { rerender } = setup();
    await act(flush);
    fireEvent.click(screen.getByRole("button", { name: "+ Add a machine" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
    });
    rerender({ now: NOW + 9 * 60_000 + 55_000 });
    expect(screen.getByText("0:05")).toBeInTheDocument();
    rerender({ now: NOW + 601_000 });
    expect(screen.getByText(/The code expired/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a new code" })).toBeInTheDocument();
  });

  it("a new machine record flips the Stepper to Joined; Done closes it", async () => {
    const { rerender } = setup();
    await act(flush);
    fireEvent.click(screen.getByRole("button", { name: "+ Add a machine" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
    });
    // A record that was already there is not the new machine.
    rerender({ machines: { "box-a": { ...boxA, agents: 4 }, "box-b": boxB } });
    expect(screen.queryByText(/joined/)).toBeNull();
    rerender({ machines: { "box-a": boxA, "box-b": boxB, "box-c": boxC } });
    expect(screen.getByRole("heading", { name: /box-c joined/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("heading", { name: /box-c joined/ })).toBeNull();
    expect(screen.getByRole("button", { name: "+ Add a machine" })).toBeInTheDocument();
  });

  it("a refused invite says why and offers to try again", async () => {
    const ops = fakeOps({
      invite: vi.fn(async () => ({
        ok: false as const,
        error: "volleyd did not answer within 10s",
      })),
    });
    setup({ ops });
    await act(flush);
    fireEvent.click(screen.getByRole("button", { name: "+ Add a machine" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("volleyd did not answer within 10s");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("Remove… asks first, then calls peer_remove", async () => {
    const { ops } = setup();
    await act(flush);
    fireEvent.click(within(card("box-a")).getByRole("button", { name: "Remove…" }));
    expect(ops.remove).not.toHaveBeenCalled();
    const confirm = within(card("box-a"));
    expect(confirm.getByText(/revokes its broker account/)).toBeInTheDocument();
    fireEvent.click(confirm.getByRole("button", { name: "Cancel" }));
    expect(ops.remove).not.toHaveBeenCalled();
    fireEvent.click(within(card("box-a")).getByRole("button", { name: "Remove…" }));
    await act(async () => {
      fireEvent.click(within(card("box-a")).getByRole("button", { name: "Remove box-a" }));
    });
    expect(ops.remove).toHaveBeenCalledWith("box-a");
    expect(screen.getByRole("status")).toHaveTextContent("box-a removed: its account was revoked");
  });

  it("a refused remove says why on the card", async () => {
    const ops = fakeOps({
      remove: vi.fn(async () => ({ ok: false, error: "box-a is not paired" })),
    });
    setup({ ops });
    await act(flush);
    fireEvent.click(within(card("box-a")).getByRole("button", { name: "Remove…" }));
    await act(async () => {
      fireEvent.click(within(card("box-a")).getByRole("button", { name: "Remove box-a" }));
    });
    expect(within(card("box-a")).getByRole("alert")).toHaveTextContent("box-a is not paired");
  });

  it("a non-admin session sees the machines but no buttons, and the terminal commands instead", async () => {
    const ops = fakeOps({ admin: vi.fn(async () => false) });
    setup({ ops });
    await act(flush);
    expect(card("box-a")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    expect(screen.getByText("volley peer invite")).toBeInTheDocument();
    expect(ops.invite).not.toHaveBeenCalled();
  });

  it("without an op channel (not signed in, demo) it is read-only too", async () => {
    setup({ ops: null });
    await act(flush);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
  });

  it("the ssh address starts as the broker's host, blank when the Desk is on this machine", () => {
    expect(sshHost("ws://hub.local:9001")).toBe("hub.local");
    expect(sshHost("ws://127.0.0.1:9001")).toBe("");
    expect(sshHost("ws://localhost:9001")).toBe("");
    expect(sshHost(null)).toBe("");
  });

  it("no paired machines yet: says how pairing works", async () => {
    setup({ machines: {} });
    await act(flush);
    expect(screen.getByText(/No other machines yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add a machine" })).toBeInTheDocument();
  });
});
