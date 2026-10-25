import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GettingStarted } from "../src/getting-started/GettingStarted";
import type { Summary } from "../src/getting-started/state";
import type { WizardContext } from "../src/getting-started/steps";
import { Done, summaryRows } from "../src/getting-started/steps/Done";
import { initialState } from "../src/store/reducer";
import { fakeOps } from "./helpers/auth-ops";
import { fakePeerOps } from "./helpers/peer-ops";

const FILLED: Summary = {
  machine: "studio",
  machines: ["studio", "box-a"],
  connectedBy: "code",
  repos: ["acme/app"],
  people: [{ name: "sam", role: "steer" }],
  network: "manual",
  coordinatorMachine: "box-a",
};
const EMPTY: Summary = { machines: [], repos: [], people: [] };

function context() {
  const { ops } = fakeOps({});
  const peerOps = fakePeerOps();
  const ctx: WizardContext = {
    ops,
    control: null,
    state: initialState(),
    deskUrl: "http://desk.example:5199/",
    identity: "admin-0123abcd",
    openSettings: vi.fn(),
    peerOps,
    sshHost: "desk.example",
  };
  return { ctx, peerOps };
}

const mount = (summary: Summary) => {
  const { ctx, peerOps } = context();
  render(<Done ctx={ctx} summary={summary} setSummary={vi.fn()} onContinue={vi.fn()} />);
  return { peerOps };
};

const row = (label: string) =>
  within(screen.getByLabelText("Summary")).getByText(label, { selector: "dt" }).nextElementSibling
    ?.textContent;

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("Getting started › You're good to go!", () => {
  it("summarises the six rows from a filled summary", () => {
    expect(summaryRows(FILLED)).toEqual([
      ["Computers", "studio, box-a"],
      ["Connected by", "Pairing code"],
      ["Repos", "acme/app"],
      ["People", "sam (Standard)"],
      ["Away from home", "VPN to box-a's network"],
      ["Coordinator", "box-a"],
    ]);
    mount(FILLED);
    expect(row("Away from home")).toBe("VPN to box-a's network");
    expect(row("Coordinator")).toBe("box-a");
  });

  it("shows — for every row an empty summary does not know", () => {
    mount(EMPTY);
    const dds = screen.getByLabelText("Summary").querySelectorAll("dd");
    expect([...dds].map((d) => d.textContent)).toEqual(["—", "—", "—", "—", "—", "—"]);
  });

  it("words the other network choices and an off coordinator", () => {
    const rows = (s: Partial<Summary>) => Object.fromEntries(summaryRows({ ...EMPTY, ...s }));
    expect(rows({ network: "tailscale" })["Away from home"]).toBe("Tailscale");
    expect(rows({ network: "none" })["Away from home"]).toBe("This network only");
    expect(rows({ network: "manual", machine: "studio" })["Away from home"]).toBe(
      "VPN to studio's network",
    );
    expect(rows({ coordinatorMachine: null }).Coordinator).toBe("off");
    expect(rows({ coordinatorMachine: "local", machine: "studio" }).Coordinator).toBe("studio");
  });

  it("Make a pairing code sends peer_invite and fills the join line; Copy copies both lines", async () => {
    const { peerOps } = mount(FILLED);
    const card = screen.getByRole("region", { name: /to add a computer/i });
    expect(within(card).getByText(/install\.sh \| sh -s -- --peer/)).toBeInTheDocument();
    const to = within(card).getByRole("textbox", { name: /this machine's ssh address/i });
    expect(to).toHaveValue("desk.example");
    fireEvent.change(to, { target: { value: "user@desk.example" } });
    fireEvent.click(within(card).getByRole("button", { name: /make a pairing code/i }));
    await waitFor(() => expect(peerOps.invite).toHaveBeenCalledTimes(1));
    expect(
      await within(card).findByText("volley peer join MXQ4-7KDP --to user@desk.example"),
    ).toBeInTheDocument();
    expect(within(card).getByText(/10 minutes/)).toBeInTheDocument();
    expect(within(card).getByText(/settings › machines/i)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /copy both lines/i }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh -s -- --peer\nvolley peer join MXQ4-7KDP --to user@desk.example",
      ),
    );
  });

  it("a refused invite says why", async () => {
    const { ctx } = context();
    ctx.peerOps = fakePeerOps({
      invite: vi.fn(async () => ({ ok: false as const, error: "not an admin" })),
    });
    render(<Done ctx={ctx} summary={EMPTY} setSummary={vi.fn()} onContinue={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /make a pairing code/i }));
    expect(await screen.findByText(/not an admin/)).toBeInTheDocument();
  });

  it("Open the Desk finishes Getting started", () => {
    const { ctx } = context();
    const onFinish = vi.fn();
    render(
      <GettingStarted
        ctx={ctx}
        initial="done"
        summary={FILLED}
        setSummary={vi.fn()}
        onClose={vi.fn()}
        onSkip={vi.fn()}
        onFinish={onFinish}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open the Desk" }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
