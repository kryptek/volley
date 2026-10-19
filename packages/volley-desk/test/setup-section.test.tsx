import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { Setup } from "../src/settings/Setup";
import { DeskStoreProvider } from "../src/store/context";
import { type AuthOps, markFirstRun } from "../src/store/control";
import { PLAN, fakeOps } from "./helpers/auth-ops";

const DESK = "http://desk.example:5199/";

function section(
  ops: AuthOps | null,
  admin: boolean,
  extra: { onPreviewSignIn?: () => void } = {},
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

  it("says accounts are off while Security still has changes", async () => {
    const { ops } = fakeOps({ setup_plan: () => ({ ok: true, result: PLAN }) });
    section(ops, true);
    expect(await screen.findByText("Off")).toBeInTheDocument();
  });

  it("asks volleyd for a new admin token, which it prints in its terminal", async () => {
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

  it("opens the wizard from Run setup again", async () => {
    const { ops } = fakeOps({ setup_plan: () => ({ ok: true, result: PLAN }) });
    section(ops, true);
    fireEvent.click(screen.getByRole("button", { name: "Open setup…" }));
    expect(await screen.findByText("mosquitto 2.1.2 (from mosquitto -h)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close setup" }));
    expect(screen.getByRole("button", { name: "Open setup…" })).toBeInTheDocument();
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
