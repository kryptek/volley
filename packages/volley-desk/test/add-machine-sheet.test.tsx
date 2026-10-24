import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { AddMachineSheet, isBoxAddress } from "../src/settings/AddMachineSheet";
import { createAuthOps } from "../src/store/control";
import { MACHINE_ADD_TIMEOUT_MS, type MachineAddAnswer, createPeerOps } from "../src/store/peerOps";
import type { DeskMessage, Envelope, MachineAddRow } from "../src/store/types";
import { fakeOps as fakeAuthOps } from "./helpers/auth-ops";
import { fakePeerOps } from "./helpers/peer-ops";

const flush = () => new Promise((r) => setTimeout(r, 0));

const row = (step: number, title: string, line?: string, state = "running"): MachineAddRow =>
  ({ step, total: 7, title, state, ...(line ? { line } : {}) }) as MachineAddRow;

/** A machineAdd that streams rows and answers only when the test says so. */
function pendingAdd() {
  let push: (r: MachineAddRow) => void = () => {};
  let answer: (a: MachineAddAnswer) => void = () => {};
  const machineAdd = vi.fn(
    (_req: unknown, onRow: (r: MachineAddRow) => void) =>
      new Promise<MachineAddAnswer>((r) => {
        push = onRow;
        answer = r;
      }),
  );
  return {
    machineAdd,
    push: (r: MachineAddRow) => act(async () => push(r)),
    answer: (a: MachineAddAnswer) => act(async () => answer(a)),
  };
}

function setup(over: Partial<ReturnType<typeof fakePeerOps>> = {}) {
  const ops = fakePeerOps(over);
  const onClose = vi.fn();
  const signIn = vi.fn((m: string) => (
    <button type="button" className="btn btn--blue">
      Sign in on {m}
    </button>
  ));
  render(<AddMachineSheet ops={ops} onClose={onClose} signIn={signIn} />);
  return { ops, onClose, signIn };
}

const sheet = () => within(screen.getByRole("dialog"));
const field = (name: RegExp) =>
  sheet().getByLabelText(name, { selector: "input:not([type=radio])" });
const type = (name: RegExp, value: string) => fireEvent.change(field(name), { target: { value } });
/** The step rows themselves (each lists its own lines inside). */
const stepItems = () => [
  ...sheet().getByRole("list", { name: "Steps" }).querySelectorAll(":scope > li"),
];

describe("isBoxAddress", () => {
  it("takes user@host and nothing an ssh option or a shell could read", () => {
    for (const ok of ["dev@box-a", "dev@box-a.lan", "ubuntu@10.0.0.7"])
      expect(isBoxAddress(ok), ok).toBe(true);
    for (const no of ["", "box-a", "-oProxyCommand=x@h", "dev@box a", "dev@", "@box", "dev@b;x"])
      expect(isBoxAddress(no), no).toBe(false);
  });
});

describe("AddMachineSheet: the form", () => {
  it("validates the address before anything is sent", () => {
    const { ops } = setup();
    type(/^Address/, "box-a");
    type(/^Password/, "pw");
    fireEvent.click(sheet().getByRole("button", { name: /^Add/ }));
    expect(sheet().getByRole("alert")).toHaveTextContent(/user@host/);
    expect(ops.machineAdd).not.toHaveBeenCalled();
    expect(field(/^Address/)).toHaveAttribute("aria-invalid", "true");
  });

  it("masks both passwords and never puts one in the page's text", () => {
    setup();
    type(/^Password/, "hunter2");
    type(/^Sudo password/, "s3cret");
    expect(field(/^Password/)).toHaveAttribute("type", "password");
    expect(field(/^Sudo password/)).toHaveAttribute("type", "password");
    expect(document.body.textContent).not.toMatch(/hunter2|s3cret/);
  });

  it("says sudo is used only when git or tmux are missing", () => {
    setup();
    expect(sheet().getByText(/only when .* lacks git or tmux/)).toBeInTheDocument();
  });

  it("sends the address, the password, the sudo password and the name", async () => {
    const add = pendingAdd();
    setup({ machineAdd: add.machineAdd });
    type(/^Address/, "dev@box-a");
    type(/^Password/, "hunter2");
    type(/^Sudo password/, "s3cret");
    type(/^Name/, "lab-1");
    fireEvent.click(sheet().getByRole("button", { name: "Add dev@box-a" }));
    await act(flush);
    expect(add.machineAdd).toHaveBeenCalledWith(
      { address: "dev@box-a", password: "hunter2", sudo: "s3cret", name: "lab-1" },
      expect.any(Function),
    );
  });

  it("with a key file instead: sends its path, no password", async () => {
    const add = pendingAdd();
    setup({ machineAdd: add.machineAdd });
    type(/^Address/, "dev@box-a");
    fireEvent.click(sheet().getByRole("radio", { name: "Key file" }));
    type(/^Key file path/, "/path/to/home/.ssh/lab");
    fireEvent.click(sheet().getByRole("button", { name: "Add dev@box-a" }));
    await act(flush);
    expect(add.machineAdd).toHaveBeenCalledWith(
      { address: "dev@box-a", key: "/path/to/home/.ssh/lab" },
      expect.any(Function),
    );
  });

  it("a relative key path is refused", () => {
    const { ops } = setup();
    type(/^Address/, "dev@box-a");
    fireEvent.click(sheet().getByRole("radio", { name: "Key file" }));
    type(/^Key file path/, "id_ed25519");
    fireEvent.click(sheet().getByRole("button", { name: "Add dev@box-a" }));
    expect(sheet().getByRole("alert")).toHaveTextContent(/absolute path/);
    expect(ops.machineAdd).not.toHaveBeenCalled();
  });
});

describe("AddMachineSheet: the run", () => {
  async function start() {
    const add = pendingAdd();
    const s = setup({ machineAdd: add.machineAdd });
    type(/^Address/, "dev@box-a");
    type(/^Password/, "hunter2");
    fireEvent.click(sheet().getByRole("button", { name: "Add dev@box-a" }));
    await act(flush);
    return { ...s, ...add };
  }

  it("shows each row as it arrives, under its step, and cannot be closed while it runs", async () => {
    const { push, onClose } = await start();
    await push(row(1, "ssh"));
    await push(row(1, "ssh", "✓ key-based ssh to dev@box-a"));
    await push(row(2, "Volley"));
    await push(row(2, "Volley", "→ install.sh --peer --version v0.5.0 --no-setup"));
    const steps = sheet().getByRole("list", { name: "Steps" });
    const items = stepItems();
    expect(items[0]).toHaveTextContent(/ssh/);
    expect(items[0]).toHaveTextContent(/key-based ssh to dev@box-a/);
    expect(items[0]).toHaveAttribute("data-state", "ok");
    expect(items[1]).toHaveTextContent(/install\.sh --peer/);
    expect(items[1]).toHaveAttribute("data-state", "running");
    // Steps not reached yet are listed, pending.
    expect(items).toHaveLength(7);
    expect(items[6]).toHaveAttribute("data-state", "pending");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    // The rows are announced as they come.
    expect(steps.closest("[aria-live]")).not.toBeNull();
  });

  it("ends with the readiness card and the sign-in buttons", async () => {
    const { push, answer, signIn } = await start();
    await push(row(7, "Doctor"));
    await answer({
      ok: true,
      name: "box-a",
      target: "dev@box-a",
      ready: false,
      signin: { gh: false, claude: false },
      checks: [
        {
          id: "gh.auth",
          ok: false,
          severity: "block",
          detail: "gh signed out",
          fix: "gh auth login",
        },
        { id: "tool.git", ok: true, severity: "block", detail: "git 2.43" },
      ],
    });
    expect(sheet().getByRole("heading", { name: /box-a is not ready yet/ })).toBeInTheDocument();
    expect(sheet().getByRole("list", { name: "Checks on box-a" })).toBeInTheDocument();
    expect(signIn).toHaveBeenCalledWith("box-a");
    expect(sheet().getByRole("button", { name: "Sign in on box-a" })).toBeInTheDocument();
    // GitHub's sign-in: the command the card's gh row gives.
    expect(sheet().getByText(/gh auth login/)).toBeInTheDocument();
  });

  it("a failure names the step and its fix, and Back keeps the form", async () => {
    const { push, answer } = await start();
    await push(row(2, "Volley"));
    await push(row(2, "Volley", "box-a lacks tmux, and only sudo installs it there", "failed"));
    await answer({ ok: false, error: "step 2 (Volley): box-a lacks tmux: give its sudo password" });
    expect(sheet().getByRole("alert")).toHaveTextContent(
      /step 2 \(Volley\).*give its sudo password/,
    );
    const items = stepItems();
    expect(items[1]).toHaveAttribute("data-state", "failed");
    fireEvent.click(sheet().getByRole("button", { name: "Back" }));
    expect(field(/^Address/)).toHaveValue("dev@box-a");
    // The password is asked again, never kept after a run.
    expect(field(/^Password/)).toHaveValue("");
  });

  it("a failure only the answer carries marks the running step failed, never ✓", async () => {
    const { push, answer } = await start();
    await push(row(1, "ssh", "✓ key-based ssh to dev@box-a"));
    await push(row(2, "Volley", "→ install.sh --peer"));
    await answer({ ok: false, error: "volleyd did not answer within 1500s" });
    const items = stepItems();
    expect(items[0]).toHaveAttribute("data-state", "ok");
    expect(items[1]).toHaveAttribute("data-state", "failed");
    expect(items[2]).toHaveAttribute("data-state", "pending");
  });

  it.each(["volley", "lighter"])("passes axe in the %s theme, form and run", async (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      const { push } = await start();
      await push(row(1, "ssh", "✓ key-based ssh to dev@box-a"));
      const res = await axe.run(screen.getByRole("dialog"), {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(res.violations.map((v) => v.id)).toEqual([]);
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });

  it("passes axe on the form", async () => {
    setup();
    const res = await axe.run(screen.getByRole("dialog"), {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("the sheet's CSS: phone width and both themes", () => {
  const css = readFileSync(path.join(__dirname, "../src/styles/machines.css"), "utf8");
  it("the progress rows use the theme tokens (dark and light), never a literal colour", () => {
    for (const sel of [".m-add-step", ".m-add-step--failed", ".m-add-lines"]) {
      const rule = css.match(new RegExp(`\\${sel}\\s*\\{[^}]*\\}`))?.[0] ?? "";
      expect(rule, sel).not.toBe("");
      expect(rule, sel).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });
  it("at phone width the form's fields stack", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(phone).toMatch(/\.m-add-form\s*\{[^}]*grid-template-columns:\s*1fr/);
  });
});

describe("peerOps.machineAdd", () => {
  it("sends machine_add with the long timeout, rows to onRow, the answer's result", async () => {
    const rows: MachineAddRow[] = [];
    const { ops, calls } = fakeAuthOps({
      machine_add: (_f, opts) => {
        opts.onProgress?.({ op: "machine_add", step: 1, total: 7, title: "ssh", state: "running" });
        return {
          ok: true,
          result: {
            name: "box-a",
            target: "dev@box-a",
            ready: true,
            signin: { gh: true, claude: true },
            checks: [],
          },
        };
      },
    });
    const peer = createPeerOps(ops, { role: "admin" });
    const a = await peer.machineAdd(
      { address: "dev@box-a", password: "hunter2", sudo: "s3cret" },
      (r) => rows.push(r),
    );
    expect(calls[0]?.fields).toEqual({
      address: "dev@box-a",
      auth: { password_ref: "hunter2" },
      sudo_ref: "s3cret",
    });
    expect(calls[0]?.opts?.timeoutMs).toBe(MACHINE_ADD_TIMEOUT_MS);
    expect(rows).toEqual([{ step: 1, total: 7, title: "ssh", state: "running" }]);
    expect(a).toMatchObject({ ok: true, name: "box-a", ready: true });
  });

  it("onProgress: each row restarts the deadline, so a long run that streams rows is not cut off", async () => {
    vi.useFakeTimers();
    try {
      const handlers = new Set<(m: DeskMessage) => void>();
      const published: Envelope[] = [];
      const client = {
        publish: vi.fn(async (_t: string, payload: string) => {
          published.push(JSON.parse(payload) as Envelope);
        }),
        onMessage: (h: (m: DeskMessage) => void) => {
          handlers.add(h);
          return () => handlers.delete(h);
        },
      };
      const auth = createAuthOps(client as never, {
        identity: "admin-1",
        replyKey: async () => ({ jwk: { kty: "RSA", n: "n", e: "AQAB" }, open: async () => ({}) }),
      });
      const pending = auth.request("machine_add", {}, { timeoutMs: 1000, onProgress: () => {} });
      await vi.advanceTimersByTimeAsync(0);
      const cid = published[0]?.correlation_id as string;
      const deliver = (type: string, payload: Record<string, unknown>) => {
        const envelope = {
          schema_version: "0.1",
          agent_id: "volleyd",
          parent_id: null,
          channel: "_system/auth",
          type,
          wall_time: "2026-10-24T12:00:00.000Z",
          correlation_id: cid,
          payload,
        } as Envelope;
        for (const h of [...handlers])
          h({ topic: `volley/_system/auth/replies/${cid}`, envelope } as DeskMessage);
      };
      // Three rows 800 ms apart: 2.4 s in all, past the 1 s deadline, never 1 s without a row.
      for (let i = 1; i <= 3; i++) {
        await vi.advanceTimersByTimeAsync(800);
        deliver("progress", { step: i });
      }
      deliver("ack", { ok: true });
      await expect(pending).resolves.toMatchObject({ ok: true });
      // A silence as long as the deadline still fails it.
      const quiet = auth.request("machine_add", {}, { timeoutMs: 1000, onProgress: () => {} });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(quiet).resolves.toMatchObject({ ok: false, unanswered: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("onProgress: the request hands volleyd's progress envelopes for it to the caller", async () => {
    const handlers = new Set<(m: DeskMessage) => void>();
    const published: Envelope[] = [];
    const client = {
      publish: vi.fn(async (_t: string, payload: string) => {
        published.push(JSON.parse(payload) as Envelope);
      }),
      onMessage: (h: (m: DeskMessage) => void) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
    };
    const auth = createAuthOps(client as never, {
      identity: "admin-1",
      replyKey: async () => ({ jwk: { kty: "RSA", n: "n", e: "AQAB" }, open: async () => ({}) }),
    });
    const seen: Record<string, unknown>[] = [];
    const pending = auth.request("machine_add", {}, { onProgress: (p) => seen.push(p) });
    await flush();
    const cid = published[0]?.correlation_id as string;
    const deliver = (type: string, agent: string, payload: Record<string, unknown>, id = cid) => {
      const envelope = {
        schema_version: "0.1",
        agent_id: agent,
        parent_id: null,
        channel: "_system/auth",
        type,
        wall_time: "2026-10-24T12:00:00.000Z",
        correlation_id: id,
        payload,
      } as Envelope;
      for (const h of [...handlers])
        h({ topic: `volley/_system/auth/replies/${cid}`, envelope } as DeskMessage);
    };
    deliver("progress", "volleyd", { step: 1 });
    deliver("progress", "someone-else", { step: 9 });
    deliver("progress", "volleyd", { step: 8 }, "other-cid");
    deliver("ack", "volleyd", { ok: true });
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(seen).toEqual([{ step: 1 }]);
  });
});
