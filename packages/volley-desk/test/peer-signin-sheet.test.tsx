import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ControlFn } from "../src/settings/ClaudeAccounts";
import { Machines, type MachinesProps } from "../src/settings/Machines";
import { PeerSignin, SigninLink } from "../src/settings/PeerSigninSheet";
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
  url: MANUAL_URL,
  flow: "manual_code",
  manual_url: MANUAL_URL,
  callback_url: LOCAL_URL,
  code_prompt: true,
  attach: ATTACH,
});

function controlOk(): ControlFn & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    result: {
      acct: ACCT,
      url: MANUAL_URL,
      flow: "manual_code",
      manual_url: MANUAL_URL,
      callback_url: LOCAL_URL,
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
  it("keeps the code-page link, the callback shortcut, the prompt and the ssh attach", () => {
    expect(signinAfter(URL_EVENT)).toMatchObject({
      acct: ACCT,
      state: "waiting",
      url: MANUAL_URL,
      flow: "manual_code",
      manual_url: MANUAL_URL,
      callback_url: LOCAL_URL,
      code_prompt: true,
      attach: ATTACH,
    });
  });

  it("a newer URL event without callback_url drops the shortcut", () => {
    const { callback_url: _c, ...rest } = URL_EVENT.envelope?.payload as Record<string, unknown>;
    expect(signinAfter(URL_EVENT, signinMsg("claude_signin_url", rest))).not.toHaveProperty(
      "callback_url",
    );
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

  it("shows the code-page link with its QR code and the one box; the shortcut only while a callback_url exists", async () => {
    const t = setup(undefined);
    fireEvent.click(card().getByRole("button", { name: "Sign in on box-a" }));
    t.rerender(signinAfter(URL_EVENT));
    const sheet = within(await screen.findByRole("dialog", { name: "Sign in on box-a" }));
    expect(sheet.getByRole("link", { name: "Open Anthropic sign-in ↗" })).toHaveAttribute(
      "href",
      MANUAL_URL,
    );
    expect(sheet.getByRole("img", { name: "QR code of the sign-in link" })).toBeInTheDocument();
    const box = sheet.getByLabelText("Paste the code, or the address your browser ended up on");
    expect(box).toHaveAttribute("type", "password");
    expect(box).toHaveAttribute("autocomplete", "off");
    expect(
      sheet.getByRole("link", { name: "Open here instead (browser on the supervisor’s machine)" }),
    ).toHaveAttribute("href", LOCAL_URL);
    // The terminal is a fallback, under its own disclosure.
    expect(sheet.getByText("Terminal instead").closest("details")).not.toHaveAttribute("open");
    const { callback_url: _c, ...rest } = URL_EVENT.envelope?.payload as Record<string, unknown>;
    t.rerender(signinAfter(signinMsg("claude_signin_url", rest)));
    expect(sheet.queryByRole("link", { name: /Open here instead/ })).toBeNull();
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
    expect(sheet.getByRole("link", { name: /Open Anthropic sign-in/ })).toHaveAttribute(
      "href",
      MANUAL_URL,
    );
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

describe("SigninLink: the link, the box, the refusals (shared with Add Claude account)", () => {
  const CODE = "abcSECRET42#def";
  const box = () =>
    screen.getByLabelText("Paste the code, or the address your browser ended up on");
  const submit = async (text: string) => {
    fireEvent.change(box(), { target: { value: text } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    });
  };
  const link = (control: ControlFn, extra: { callbackUrl?: string } = {}) =>
    render(
      <SigninLink
        acct="work@box-a"
        machine="box-a"
        url={MANUAL_URL}
        manualUrl={MANUAL_URL}
        attach={ATTACH}
        control={control}
        {...extra}
      />,
    );

  it("Submit sends claude_signin_entry with the text as typed and empties the box; done shows the masked e-mail", async () => {
    const control = vi.fn(async () => ({
      ok: true,
      result: { acct: "work@box-a", signed_in: true, email: "owner@example.com" },
    })) as unknown as ControlFn & ReturnType<typeof vi.fn>;
    link(control);
    await submit(` ${CODE} `);
    expect(control.mock.calls[0]?.slice(0, 2)).toEqual([
      "claude_signin_entry",
      { acct: "work@box-a", entry: CODE },
    ]);
    expect(document.body).toHaveTextContent("Signed in as o•••@example.com");
    expect(document.body).not.toHaveTextContent("owner@example.com");
    expect(document.body.innerHTML).not.toContain(CODE);
  });

  it("the box is emptied at once, before volleyd answers", async () => {
    let answer!: (r: { ok: boolean }) => void;
    const control = vi.fn(
      () =>
        new Promise((r) => {
          answer = r;
        }),
    ) as unknown as ControlFn;
    link(control);
    fireEvent.change(box(), { target: { value: CODE } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(box()).toHaveValue("");
    await act(async () => answer({ ok: true }));
  });

  it("a fresh: true refusal shows volleyd's words and Get a fresh link, which sends claude_signin and swaps the link", async () => {
    const NEW_URL = MANUAL_URL.replace("state=s", "state=t");
    const control = vi.fn(async (op: string) =>
      op === "claude_signin_entry"
        ? { ok: false, error: "code rejected: Invalid code", fresh: true }
        : { ok: true, result: { acct: "work@box-a", url: NEW_URL, manual_url: NEW_URL } },
    ) as unknown as ControlFn & ReturnType<typeof vi.fn>;
    link(control);
    await submit(CODE);
    expect(screen.getByRole("alert")).toHaveTextContent("code rejected: Invalid code");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Get a fresh link" }));
    });
    expect(control.mock.calls[1]?.slice(0, 2)).toEqual(["claude_signin", { acct: "work@box-a" }]);
    expect(screen.getByRole("link", { name: "Open Anthropic sign-in ↗" })).toHaveAttribute(
      "href",
      NEW_URL,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the another-sign-in refusal shows without the pasted address", async () => {
    const address = "http://localhost:51052/callback?code=abcSECRET42&state=xyzSTATE42";
    const control = vi.fn(async () => ({
      ok: false,
      error: "that address belongs to another sign-in; open a fresh link",
    })) as unknown as ControlFn;
    link(control);
    await submit(address);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "that address belongs to another sign-in; open a fresh link",
    );
    expect(screen.getByRole("button", { name: "Get a fresh link" })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("abcSECRET42");
    expect(document.body.innerHTML).not.toContain("xyzSTATE42");
    expect(box()).toHaveValue("");
  });

  it("Open here instead appears only with a callback_url", () => {
    const { unmount } = link(controlOk());
    expect(screen.queryByRole("link", { name: /Open here instead/ })).toBeNull();
    unmount();
    link(controlOk(), { callbackUrl: LOCAL_URL });
    expect(screen.getByRole("link", { name: /Open here instead/ })).toHaveAttribute(
      "href",
      LOCAL_URL,
    );
  });
});
