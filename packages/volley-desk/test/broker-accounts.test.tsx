import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeQr, qrPath } from "../src/lib/qr";
import { BrokerAccounts } from "../src/settings/BrokerAccounts";
import { useAdminRole } from "../src/settings/Setup";
import type { SteerClient } from "../src/steer/transport";
import { CREDENTIALS_STORAGE_KEY } from "../src/store/context";
import { type AuthOps, type BrokerAccount, createAuthOps } from "../src/store/control";
import type { DeskMessage, Envelope } from "../src/store/types";
import { fakeOps } from "./helpers/auth-ops";

const ME = "admin-0123abcd";
const NOW = Date.parse("2026-10-19T12:00:00Z");

const ACCOUNTS: BrokerAccount[] = [
  {
    name: ME,
    role: "admin",
    kind: "device",
    created: "2026-10-18T18:12:00Z",
    label: "Desk on Mac",
    last_seen: "2026-10-19T12:00:00Z",
  },
  {
    name: "desk-ipad",
    role: "steer",
    kind: "device",
    created: "2026-10-18T19:00:00Z",
    last_seen: "2026-10-19T11:58:00Z",
  },
  { name: "viewer-tv", role: "watch", kind: "device", created: "2026-10-18T19:05:00Z" },
];

function admin(handlers: Parameters<typeof fakeOps>[0] = {}) {
  let list = [...ACCOUNTS];
  const f = fakeOps({
    account_list: () => ({ ok: true, result: { accounts: list } }),
    ...handlers,
  });
  const set = (l: BrokerAccount[]) => {
    list = l;
  };
  return { ...f, set };
}

function section(ops: AuthOps | null, isAdmin: boolean) {
  return render(<BrokerAccounts ops={ops} admin={isAdmin} identity={ME} now={NOW} />);
}

const rowOf = (name: string) => {
  const cell = screen.getByText(name);
  const tr = cell.closest("tr");
  if (!(tr instanceof HTMLElement)) throw new Error(`no row for ${name}`);
  return within(tr);
};

describe("Settings › Broker accounts", () => {
  it("lists the accounts with their role, where and when last seen", async () => {
    const { ops, calls } = admin();
    section(ops, true);
    expect(await screen.findByText("desk-ipad")).toBeInTheDocument();
    expect(calls[0]?.op).toBe("account_list");
    expect(rowOf("desk-ipad").getByText("can steer")).toBeInTheDocument();
    expect(rowOf("desk-ipad").getByText("2m ago")).toBeInTheDocument();
    expect(rowOf("viewer-tv").getByText("can watch")).toBeInTheDocument();
    expect(rowOf("viewer-tv").getByText("never")).toBeInTheDocument();
    expect(rowOf(ME).getByText("admin")).toBeInTheDocument();
    // Agent logins are the supervisor's, made per spawn: nothing to manage here.
    expect(screen.getByText(/Nothing to manage/)).toBeInTheDocument();
    // Your own account is not offered for revoke (it would sign this browser out for good).
    expect(rowOf(ME).queryByRole("button")).not.toBeInTheDocument();
  });

  it("creates an account and shows its password once, with a QR code", async () => {
    const { ops, calls, set } = admin({
      account_create: (f) => {
        set([
          ...ACCOUNTS,
          { name: f.name as string, role: f.role as string, kind: "device", created: "x" },
        ]);
        return {
          ok: true,
          result: { name: f.name, role: f.role },
          secret: { username: f.name, password: "pa55-w0rd-once" },
        };
      },
    });
    section(ops, true);
    await screen.findByText("desk-ipad");
    fireEvent.click(screen.getByRole("button", { name: "New account" }));
    fireEvent.click(screen.getByRole("radio", { name: "Viewer (watch only)" }));
    const name = screen.getByLabelText("Name");
    expect(name).toHaveValue("viewer-tv");
    fireEvent.change(name, { target: { value: "viewer-den" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("pa55-w0rd-once")).toBeInTheDocument();
    expect(calls.find((c) => c.op === "account_create")?.fields).toEqual({
      name: "viewer-den",
      role: "watch",
      kind: "device",
    });
    expect(screen.getByText("Password for viewer-den (shown once)")).toBeInTheDocument();
    const qr = screen.getByRole("img", { name: /QR code/i });
    expect(qr.querySelector("path")?.getAttribute("d")).toBe(qrPath(encodeQr("pa55-w0rd-once")));
    await waitFor(() => expect(screen.getByRole("table")).toHaveTextContent("viewer-den"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("pa55-w0rd-once")).not.toBeInTheDocument();
  });

  it("refuses a name outside the agent-id grammar before asking", async () => {
    const { ops, calls } = admin();
    section(ops, true);
    await screen.findByText("desk-ipad");
    fireEvent.click(screen.getByRole("button", { name: "New account" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Desk iPad" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/lowercase/);
    expect(calls.some((c) => c.op === "account_create")).toBe(false);
  });

  it("rotates a password through account_rotate and shows the new one once", async () => {
    const { ops, calls } = admin({
      account_rotate: (f) => ({
        ok: true,
        result: { name: f.name, role: "steer" },
        secret: { username: f.name, password: "n3w-pa55" },
      }),
    });
    section(ops, true);
    await screen.findByText("desk-ipad");
    fireEvent.click(rowOf("desk-ipad").getByRole("button", { name: "Rotate" }));
    expect(await screen.findByText("n3w-pa55")).toBeInTheDocument();
    expect(calls.find((c) => c.op === "account_rotate")?.fields).toEqual({ name: "desk-ipad" });
  });

  it("revokes only after a confirm, through account_revoke", async () => {
    const { ops, calls, set } = admin({
      account_revoke: (f) => {
        set(ACCOUNTS.filter((a) => a.name !== f.name));
        return { ok: true, result: { name: f.name } };
      },
    });
    section(ops, true);
    await screen.findByText("desk-ipad");
    fireEvent.click(rowOf("desk-ipad").getByRole("button", { name: "Revoke…" }));
    expect(calls.some((c) => c.op === "account_revoke")).toBe(false);
    fireEvent.click(rowOf("desk-ipad").getByRole("button", { name: "Keep" }));
    expect(calls.some((c) => c.op === "account_revoke")).toBe(false);
    fireEvent.click(rowOf("desk-ipad").getByRole("button", { name: "Revoke…" }));
    fireEvent.click(rowOf("desk-ipad").getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByText("desk-ipad")).not.toBeInTheDocument());
    expect(calls.find((c) => c.op === "account_revoke")?.fields).toEqual({ name: "desk-ipad" });
    expect(screen.getByRole("status")).toHaveTextContent(/desk-ipad can no longer connect/);
  });

  it("shows volleyd's refusal and keeps the row", async () => {
    const { ops } = admin({
      account_revoke: () => ({ ok: false, error: "volley auth revoke: no such account" }),
    });
    section(ops, true);
    await screen.findByText("desk-ipad");
    fireEvent.click(rowOf("desk-ipad").getByRole("button", { name: "Revoke…" }));
    fireEvent.click(rowOf("desk-ipad").getByRole("button", { name: "Revoke" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no such account");
    expect(screen.getByText("desk-ipad")).toBeInTheDocument();
  });

  it("a non-admin session sees the table read-only, with no action buttons", () => {
    const { ops, calls } = fakeOps({});
    render(<BrokerAccounts ops={ops} admin={false} identity="desk" now={NOW} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("desk")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Only an admin/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

describe("createAuthOps (SPEC §4.6.10)", () => {
  /** A client recording publishes; `answer` delivers an envelope on a topic. */
  function client() {
    const published: { topic: string; env: Envelope }[] = [];
    const handlers = new Set<(m: DeskMessage) => void>();
    const c: SteerClient = {
      publish: async (topic, payload) => {
        published.push({ topic, env: JSON.parse(payload) as Envelope });
      },
      onMessage: (h) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
    };
    const deliver = (topic: string, env: Envelope) => {
      for (const h of [...handlers]) h({ topic, envelope: env, receivedAt: 0, retained: false });
    };
    return { c, published, deliver };
  }
  const ack = (cid: string, payload: Record<string, unknown>, agent = "volleyd"): Envelope => ({
    schema_version: "0.1",
    agent_id: agent,
    parent_id: null,
    channel: "_system/auth",
    type: "ack",
    wall_time: new Date(NOW).toISOString(),
    correlation_id: cid,
    payload,
  });

  it("asks on the admin's own ops topic with a reply_key and opens the sealed answer", async () => {
    const { c, published, deliver } = client();
    const ops = createAuthOps(c, { identity: ME, newId: () => "cid-00000001" });
    const pending = ops.request("account_rotate", { name: "desk-ipad" });
    await waitFor(() => expect(published).toHaveLength(1));
    const req = published[0] as { topic: string; env: Envelope };
    expect(req.topic).toBe(`volley/_system/auth/ops/${ME}`);
    expect(req.env).toMatchObject({
      agent_id: ME,
      channel: "_system/auth",
      type: "query",
      correlation_id: "cid-00000001",
    });
    const p = req.env.payload as Record<string, unknown>;
    expect(p).toMatchObject({ op: "account_rotate", name: "desk-ipad" });
    const jwk = p.reply_key as JsonWebKey;
    expect(jwk.kty).toBe("RSA");
    expect(jwk.d).toBeUndefined();
    const sealed = publicEncrypt(
      {
        key: createPublicKey({ key: jwk as never, format: "jwk" }),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(JSON.stringify({ username: "desk-ipad", password: "n3w" })),
    ).toString("base64url");
    // Only volleyd's answer on the request's own reply topic counts (SPEC §4.4).
    deliver(
      "volley/_system/auth/replies/cid-00000001",
      ack("cid-00000001", { ok: false }, "mallory"),
    );
    deliver("volley/_system/auth/replies/other", ack("cid-00000001", { ok: false }));
    deliver(
      "volley/_system/auth/replies/cid-00000001",
      ack("cid-00000001", {
        text: "ACKED",
        acked_type: "query",
        op: "account_rotate",
        ok: true,
        result: { name: "desk-ipad", role: "steer" },
        sealed,
      }),
    );
    expect(await pending).toEqual({
      ok: true,
      result: { name: "desk-ipad", role: "steer" },
      secret: { username: "desk-ipad", password: "n3w" },
    });
  });

  it("reports no answer in time, and a publish the broker refused", async () => {
    const { c } = client();
    const ops = createAuthOps(c, { identity: ME, timeoutMs: 50 });
    expect(await ops.request("account_list")).toEqual({
      ok: false,
      error: "volleyd did not answer within 0.05s",
      unanswered: true,
    });
    const refused: SteerClient = {
      publish: async () => {
        throw new Error("not connected to the broker");
      },
      onMessage: () => () => {},
    };
    expect(await createAuthOps(refused, { identity: ME }).request("account_list")).toEqual({
      ok: false,
      error: "not connected to the broker",
      unsent: true,
    });
  });
});

describe("useAdminRole", () => {
  function Probe({ ops, identity, ask }: { ops: AuthOps | null; identity: string; ask: boolean }) {
    const { admin, role } = useAdminRole(ops, identity, ask);
    return (
      <div data-testid="role">
        {admin ? "admin" : "not-admin"}:{role ?? "unknown"}
      </div>
    );
  }
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("trusts the stored role at once", () => {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify({ username: ME, password: "pw", role: "admin" }),
    );
    const { ops, calls } = fakeOps({});
    render(<Probe ops={ops} identity={ME} ask={false} />);
    expect(screen.getByTestId("role")).toHaveTextContent("admin:admin");
    expect(calls).toHaveLength(0);
  });

  it("asks account_list once an admin section opens, and remembers a yes", async () => {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify({ username: "ops-admin", password: "pw" }),
    );
    const { ops, calls } = fakeOps({
      account_list: () => ({ ok: true, result: { accounts: [] } }),
    });
    const r = render(<Probe ops={ops} identity="ops-admin" ask={false} />);
    expect(calls).toHaveLength(0);
    r.rerender(<Probe ops={ops} identity="ops-admin" ask />);
    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("admin:admin"));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(CREDENTIALS_STORAGE_KEY) ?? "{}").role).toBe("admin");
  });

  it("never asks for a fixed identity, which is not an account", () => {
    const { ops, calls } = fakeOps({});
    render(<Probe ops={ops} identity="desk" ask />);
    expect(screen.getByTestId("role")).toHaveTextContent("not-admin:unknown");
    expect(calls).toHaveLength(0);
  });
});
