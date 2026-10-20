import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ControlFn } from "../src/settings/ClaudeAccounts";
import { Machines, type MachinesProps } from "../src/settings/Machines";
import { PeerSignin } from "../src/settings/PeerSigninSheet";
import { initialState, reduceAll } from "../src/store/reducer";
import type { ClaudeSignin, DeskMessage } from "../src/store/types";
import { NOW, machineRecord, readiness } from "./helpers/desk-msgs";
import { fakePeerOps } from "./helpers/peer-ops";

const ACCT = "primary@box-a";
const LOCAL_URL =
  "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A51051%2Fcallback&state=s";
const MANUAL_URL =
  "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s";
const ATTACH = "ssh dev@box-a -t tmux attach -t volley-signin-primary";

function signinMsg(type: string, payload: Record<string, unknown>): DeskMessage {
  return {
    topic: `volley/_system/claude/${ACCT}/signin`,
    envelope: {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel: "_system/claude",
      type,
      wall_time: new Date(NOW).toISOString(),
      payload: { acct: ACCT, ...payload },
    },
    receivedAt: NOW,
  };
}

/** The store's sign-in after these events (the reducer keys it `primary@<name>`). */
function signinAfter(...msgs: DeskMessage[]): ClaudeSignin | undefined {
  return reduceAll(initialState(), msgs).signins?.[ACCT];
}

const URL_EVENT = signinMsg("claude_signin_url", {
  url: LOCAL_URL,
  flow: "browser_callback",
  manual_url: MANUAL_URL,
  attach: ATTACH,
});

function controlOk(): ControlFn & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    result: {
      acct: ACCT,
      url: LOCAL_URL,
      flow: "browser_callback",
      manual_url: MANUAL_URL,
      attach: ATTACH,
    },
  })) as unknown as ControlFn & ReturnType<typeof vi.fn>;
}

/** Settings › Machines with the sign-in slot filled as the App fills it. */
function setup(signin: ClaudeSignin | undefined, control: ControlFn = controlOk()) {
  const ops = fakePeerOps({ known: vi.fn(() => "admin" as const) });
  const props = (s: ClaudeSignin | undefined): MachinesProps => ({
    machines: { "box-a": machineRecord() },
    readiness: { "box-a": readiness() },
    hosts: ["box-a"],
    hubUp: true,
    ops,
    now: NOW,
    signIn: (name) => <PeerSignin machine={name} signin={s} control={control} ops={ops} />,
  });
  const view = render(<Machines {...props(signin)} />);
  return {
    ops,
    control,
    rerender: (s: ClaudeSignin | undefined) => view.rerender(<Machines {...props(s)} />),
  };
}

const card = () => within(screen.getByRole("article", { name: "box-a" }));

describe("the store keys a paired machine's sign-in by primary@<name>", () => {
  it("keeps the phone's manual_url and the ssh attach", () => {
    expect(signinAfter(URL_EVENT)).toMatchObject({
      acct: ACCT,
      state: "waiting",
      url: LOCAL_URL,
      flow: "browser_callback",
      manual_url: MANUAL_URL,
      attach: ATTACH,
    });
  });
});

describe("Sign in on <machine>: PeerSigninSheet", () => {
  it("the card's button starts claude_signin for primary@<name>", async () => {
    const t = setup(undefined);
    fireEvent.click(card().getByRole("button", { name: "Sign in on box-a" }));
    await waitFor(() => expect(t.control).toHaveBeenCalled());
    expect((t.control as ReturnType<typeof vi.fn>).mock.calls[0]?.slice(0, 2)).toEqual([
      "claude_signin",
      { acct: ACCT },
    ]);
  });

  it("renders Open sign-in with the forwarded localhost URL, and the phone disclosure", async () => {
    const t = setup(undefined);
    fireEvent.click(card().getByRole("button", { name: "Sign in on box-a" }));
    t.rerender(signinAfter(URL_EVENT));
    const sheet = within(await screen.findByRole("dialog", { name: "Sign in on box-a" }));
    const open = sheet.getByRole("link", { name: /Open sign-in/ });
    expect(open).toHaveAttribute("href", LOCAL_URL);
    expect(sheet.getByText(/browser on this computer/)).toBeInTheDocument();
    // The phone disclosure: the manual URL to open there, then the attach command.
    const phone = sheet.getByText("From a phone instead");
    fireEvent.click(phone);
    expect(sheet.getByRole("link", { name: /Open on the phone/ })).toHaveAttribute(
      "href",
      MANUAL_URL,
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(ATTACH);
    expect(sheet.getByText(/never into Volley/)).toBeInTheDocument();
    // No field of any kind: a code is never typed into the Desk.
    const dialog = screen.getByRole("dialog", { name: "Sign in on box-a" });
    expect(dialog.querySelectorAll("input, textarea, select, [contenteditable]")).toHaveLength(0);
    expect(within(dialog).queryByRole("textbox")).toBeNull();
  });

  it("claude_signin_done turns the card green with the plan and refreshes the doctor (fix: false)", async () => {
    const t = setup(undefined);
    fireEvent.click(card().getByRole("button", { name: "Sign in on box-a" }));
    t.rerender(signinAfter(URL_EVENT));
    await screen.findByRole("dialog", { name: "Sign in on box-a" });
    await act(async () =>
      t.rerender(signinAfter(URL_EVENT, signinMsg("claude_signin_done", { plan: "max" }))),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("Signed in · Max");
    await waitFor(() => expect(t.ops.doctor).toHaveBeenCalledWith("box-a", { fix: false }));
    expect(t.ops.doctor).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    const green = card().getByText(/Claude signed in · Max/);
    expect(green).toHaveClass("m-ready--ok");
    expect(card().queryByRole("button", { name: "Sign in on box-a" })).toBeNull();
  });

  it("claude_signin_failed shows the reason", async () => {
    const t = setup(undefined);
    fireEvent.click(card().getByRole("button", { name: "Sign in on box-a" }));
    await act(async () =>
      t.rerender(
        signinAfter(
          URL_EVENT,
          signinMsg("claude_signin_failed", {
            reason: "no tmux on dev@box-a; run `ssh dev@box-a -t claude auth login`",
          }),
        ),
      ),
    );
    const alert = within(screen.getByRole("dialog")).getByRole("alert");
    expect(alert).toHaveTextContent("ssh dev@box-a -t claude auth login");
  });

  it("an earlier sign-in's failure is not shown again when the sheet reopens", async () => {
    const failed = signinAfter(
      URL_EVENT,
      signinMsg("claude_signin_failed", { reason: "timed out after 900 s" }),
    );
    setup(failed);
    await act(async () => {
      fireEvent.click(card().getByRole("button", { name: "Sign in on box-a" }));
    });
    const sheet = within(await screen.findByRole("dialog", { name: "Sign in on box-a" }));
    expect(sheet.queryByRole("alert")).toBeNull();
    expect(sheet.getByRole("link", { name: /Open sign-in/ })).toHaveAttribute("href", LOCAL_URL);
  });

  it("volleyd refusing the sign-in shows its error", async () => {
    const control = vi.fn(async () => ({
      ok: false,
      error: "Claude Code on 'box-a' is already signed in",
    })) as unknown as ControlFn;
    setup(undefined, control);
    fireEvent.click(card().getByRole("button", { name: "Sign in on box-a" }));
    const alert = await within(await screen.findByRole("dialog")).findByRole("alert");
    expect(alert).toHaveTextContent("already signed in");
  });

  it("the supervisor's own machine (this one) gets no sign-in button", () => {
    const ops = fakePeerOps({ known: vi.fn(() => "admin" as const) });
    render(
      <Machines
        machines={{ hub: machineRecord({ name: "hub" }) }}
        localName="hub"
        hubUp
        ops={ops}
        now={NOW}
        signIn={(name) => (
          <PeerSignin machine={name} signin={undefined} control={controlOk()} ops={ops} />
        )}
      />,
    );
    expect(screen.queryByRole("button", { name: /Sign in on/ })).toBeNull();
  });

  it("a machine whose doctor already reports Claude signed in gets no button", () => {
    const ops = fakePeerOps();
    render(
      <PeerSignin machine="box-a" signin={undefined} signedIn control={controlOk()} ops={ops} />,
    );
    expect(screen.queryByRole("button", { name: "Sign in on box-a" })).toBeNull();
  });
});
