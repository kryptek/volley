import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { SignInGate } from "../src/auth/SignInGate";
import { Setup, type SetupProps } from "../src/settings/Setup";
import { CREDENTIALS_STORAGE_KEY, DeskStoreProvider, useDesk } from "../src/store/context";
import {
  type AuthOps,
  type RedeemRequest,
  markFirstRun,
  readSessionRole,
} from "../src/store/control";
import { PLAN, fakeOps } from "./helpers/auth-ops";
import { connectingFactory } from "./helpers/desk-msgs";

const DESK = "http://desk.example:5199/";

function section(
  ops: AuthOps | null,
  admin: boolean,
  extra: Pick<
    SetupProps,
    "onPreviewSignIn" | "onOpenSetup" | "gettingStarted" | "onOpenGettingStarted"
  > = {},
) {
  return render(
    <Setup
      ops={ops}
      admin={admin}
      identity={admin ? "admin-0123abcd" : "desk"}
      brokerUrl="ws://desk.example:9001"
      deskUrl={DESK}
      {...extra}
    />,
  );
}

/** The value cell of the settings row labelled `label`. */
const row = (label: string) => {
  const l = screen.getByText(label);
  const r = l.closest(".s-row");
  if (!(r instanceof HTMLElement)) throw new Error(`no row ${label}`);
  return within(r);
};

describe("Settings › Setup & Security", () => {
  it("shows the broker's state from setup_plan to an admin", async () => {
    const { ops, calls } = fakeOps({
      setup_plan: () => ({
        ok: true,
        result: {
          ...PLAN,
          // A secured broker: nothing left to change in Security.
          steps: PLAN.steps.map((s) => (s.step === "security" ? { ...s, changes: [] } : s)),
        },
      }),
    });
    section(ops, true);
    expect(await screen.findByText("On")).toBeInTheDocument();
    expect(calls[0]?.op).toBe("setup_plan");
    expect(row("Listening").getByText(/1883: refuses anonymous clients/)).toBeInTheDocument();
    expect(row("Connected to").getByText("ws://desk.example:9001")).toBeInTheDocument();
    expect(row("Last setup").getByText(/backups kept/i)).toBeInTheDocument();
  });

  it("a Desk on the private network shows the wss:// broker it signs in to", async () => {
    const { ops } = fakeOps({ setup_plan: () => ({ ok: true, result: PLAN }) });
    render(
      <Setup
        ops={ops}
        admin={true}
        identity="admin-0123abcd"
        brokerUrl="wss://desk.example.ts.net:8443"
        deskUrl="https://desk.example.ts.net/"
      />,
    );
    expect(await screen.findByText("On")).toBeInTheDocument();
    expect(row("Connected to").getByText("wss://desk.example.ts.net:8443")).toBeInTheDocument();
  });

  it("reads accounts-required from the listeners, and shows pending Security changes apart", async () => {
    // Both listeners refuse anonymous clients; Security still has a change (a LAN toggle).
    const { ops } = fakeOps({ setup_plan: () => ({ ok: true, result: PLAN }) });
    section(ops, true);
    expect(await screen.findByText("On")).toBeInTheDocument();
    expect(row("Security").getByText("2 pending")).toBeInTheDocument();
  });

  it("says accounts are off while a listener takes anonymous clients", async () => {
    const open = {
      ...PLAN,
      steps: PLAN.steps.map((s) =>
        s.step === "detect"
          ? {
              ...s,
              found: ["Listener 1883: accepts anonymous clients", "Listener 9001: not listening"],
            }
          : s,
      ),
    };
    const { ops } = fakeOps({ setup_plan: () => ({ ok: true, result: open }) });
    section(ops, true);
    expect(await screen.findByText("Off")).toBeInTheDocument();
  });

  it("shows a new admin token once when volleyd seals it to this browser", async () => {
    const token = "vly_admin_89abcdef_0123456789abcdef0123456789abcdef";
    const { ops } = fakeOps({
      setup_plan: () => ({ ok: true, result: PLAN }),
      admin_token: () => ({
        ok: true,
        result: { token_id: "89abcdef", expires_at: "2026-10-19T12:10:00Z" },
        secret: { token },
      }),
    });
    section(ops, true);
    fireEvent.click(screen.getByRole("button", { name: /Issue new token/ }));
    expect(await screen.findByText(token)).toBeInTheDocument();
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
    expect(screen.queryByText(/printed in the terminal/i)).not.toBeInTheDocument();
  });

  it("issues the shared desk login a new password, after asking, and shows it once", async () => {
    const password = "N3w-desk-pa55word-0123456789abcdef";
    const { ops, calls } = fakeOps({
      setup_plan: () => ({ ok: true, result: PLAN }),
      desk_password: () => ({
        ok: true,
        result: { username: "desk" },
        secret: { username: "desk", password },
      }),
    });
    section(ops, true);
    fireEvent.click(screen.getByRole("button", { name: "New desk password" }));
    // It signs out whatever uses the old one: asked first, nothing sent yet.
    expect(screen.getByText(/signs out whatever signs in as desk now/i)).toBeInTheDocument();
    expect(calls.map((c) => c.op)).not.toContain("desk_password");
    fireEvent.click(screen.getByRole("button", { name: "Issue it" }));
    expect(await screen.findByText(password)).toBeInTheDocument();
    expect(screen.getByText(/desk login password \(shown once\)/i)).toBeInTheDocument();
    expect(calls.map((c) => c.op)).toContain("desk_password");
  });

  it("says what to do when volleyd cannot issue the desk password", async () => {
    const { ops } = fakeOps({ setup_plan: () => ({ ok: true, result: PLAN }) });
    section(ops, true);
    fireEvent.click(screen.getByRole("button", { name: "New desk password" }));
    fireEvent.click(screen.getByRole("button", { name: "Issue it" }));
    expect(await screen.findByText(/cannot issue the desk password/i)).toBeInTheDocument();
  });

  it("says where the token went when volleyd printed it in its terminal", async () => {
    const { ops, calls } = fakeOps({
      setup_plan: () => ({ ok: true, result: PLAN }),
      admin_token: () => ({ ok: true, result: { expires_at: "2026-10-19T12:10:00Z" } }),
    });
    section(ops, true);
    fireEvent.click(screen.getByRole("button", { name: /Issue new token/ }));
    expect(await screen.findByText(/printed in the terminal running volleyd/i)).toBeInTheDocument();
    expect(calls.map((c) => c.op)).toContain("admin_token");
  });

  it("falls back to `volley auth token` when volleyd cannot issue one", async () => {
    const { ops } = fakeOps({ setup_plan: () => ({ ok: true, result: PLAN }) });
    section(ops, true);
    fireEvent.click(screen.getByRole("button", { name: /Issue new token/ }));
    expect(await screen.findByText("volley auth token")).toBeInTheDocument();
  });

  it("opens the wizard (in its own modal) from Run setup again, as a repair", async () => {
    const { ops } = fakeOps({ setup_plan: () => ({ ok: true, result: PLAN }) });
    const onOpenSetup = vi.fn();
    section(ops, true, { onOpenSetup });
    fireEvent.click(screen.getByRole("button", { name: "Open setup…" }));
    expect(onOpenSetup).toHaveBeenCalledWith(true);
  });

  it("shows Getting started's state to an admin, and Open… reopens it", async () => {
    const { ops } = fakeOps({ setup_plan: () => ({ ok: true, result: PLAN }) });
    const onOpenGettingStarted = vi.fn();
    const view = section(ops, true, { gettingStarted: null, onOpenGettingStarted });
    expect(await screen.findByText("On")).toBeInTheDocument();
    expect(row("Getting started").getByText("Not yet")).toBeInTheDocument();
    fireEvent.click(row("Getting started").getByRole("button", { name: "Open…" }));
    expect(onOpenGettingStarted).toHaveBeenCalledOnce();
    const at = "2026-10-24T12:00:00.000Z";
    const day = new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });
    view.unmount();
    const finished = section(ops, true, {
      gettingStarted: { kind: "finished", at },
      onOpenGettingStarted,
    });
    expect(row("Getting started").getByText(`Finished ${day}`)).toBeInTheDocument();
    finished.unmount();
    section(ops, true, { gettingStarted: { kind: "skipped", at }, onOpenGettingStarted });
    expect(row("Getting started").getByText(`Skipped ${day}`)).toBeInTheDocument();
    await screen.findByText("On");
  });

  it("a non-admin browser has no Getting started row", () => {
    section(fakeOps({}).ops, false, { onOpenGettingStarted: vi.fn() });
    expect(screen.queryByText("Getting started")).not.toBeInTheDocument();
  });

  it("previews the sign-in screen", () => {
    const onPreviewSignIn = vi.fn();
    section(null, false, { onPreviewSignIn });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(onPreviewSignIn).toHaveBeenCalled();
  });

  it("a non-admin browser sees no admin actions, and how to become one", () => {
    const { ops, calls } = fakeOps({});
    section(ops, false);
    expect(screen.queryByRole("button", { name: /Issue new token/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open setup…" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/volley auth token/).length).toBeGreaterThan(0);
    // Only an admin may ask: nothing was sent.
    expect(calls).toHaveLength(0);
  });

  it("takes a pasted admin token and signs in with it", () => {
    const go = vi.fn();
    render(
      <Setup
        ops={null}
        admin={false}
        identity="desk"
        brokerUrl="ws://desk.example:9001"
        deskUrl={DESK}
        onUseToken={go}
      />,
    );
    const field = screen.getByLabelText("Admin token");
    fireEvent.change(field, { target: { value: "not a token" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with token" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/vly_admin_/);
    expect(go).not.toHaveBeenCalled();
    const token = "vly_admin_89abcdef_0123456789abcdef0123456789abcdef";
    fireEvent.change(field, { target: { value: ` ${token} ` } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with token" }));
    expect(go).toHaveBeenCalledWith(token);
  });

  it("in a signed-in session the admin token signs in in place, through the Switch account entry (#328)", async () => {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify({ username: "steer-11112222", password: "old", role: "steer" }),
    );
    const token = "vly_admin_89abcdef_0123456789abcdef0123456789abcdef";
    const redeem = vi.fn(async (_r: RedeemRequest) => ({
      ok: true as const,
      username: "admin-89abcdef",
      password: "pw",
      role: "admin",
      label: "Desk on Mac",
    }));
    function Signed() {
      const { identity } = useDesk();
      return (
        <>
          <div data-testid="who">{identity}</div>
          <Setup
            ops={null}
            admin={false}
            identity={identity}
            brokerUrl="ws://desk.example:9001"
            deskUrl={DESK}
          />
        </>
      );
    }
    render(
      <SignInGate
        demo={false}
        env={{}}
        brokerUrl="ws://desk.example:9001"
        clientFactory={connectingFactory().make}
        redeem={redeem}
      >
        <Signed />
      </SignInGate>,
    );
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("steer-11112222"));
    fireEvent.change(screen.getByLabelText("Admin token"), { target: { value: token } });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Sign in with token" })),
    );
    expect(redeem).toHaveBeenCalledWith(expect.objectContaining({ token }));
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("admin-89abcdef"));
    expect(readSessionRole("admin-89abcdef")).toBe("admin");
    localStorage.clear();
    sessionStorage.clear();
  });
});

describe("App: Setup & Security", () => {
  const renderApp = () =>
    render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );

  it("opens Settings › Setup & Security once after an admin token sign-in", () => {
    markFirstRun();
    const first = renderApp();
    const settings = screen.getByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Setup & Security",
    );
    first.unmount();
    renderApp();
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("previews the sign-in screen, and Close goes back to setup", () => {
    markFirstRun();
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const preview = screen.getByRole("dialog", { name: "Sign-in screen preview" });
    expect(
      within(preview).getByRole("form", { name: "Sign in to the broker" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    fireEvent.click(within(preview).getByRole("button", { name: "Sign in" }));
    expect(within(preview).getByRole("alert")).toHaveTextContent(/preview/i);
    fireEvent.click(within(preview).getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("dialog", { name: "Sign-in screen preview" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });
});
