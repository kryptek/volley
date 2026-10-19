import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { encodeQr, matrixText, qrPath } from "../src/lib/qr";
import { SetupWizard } from "../src/settings/SetupWizard";
import type { AuthOps } from "../src/store/control";
import { PLAN, fakeOps } from "./helpers/auth-ops";

const TOKEN = "vly_admin_89abcdef_0123456789abcdef0123456789abcdef";
const SIGNIN = "vly_signin_0a1b2c3d_00112233445566778899aabbccddeeff";
const DESK = "http://desk.example:5199/";

function wizard(ops: AuthOps) {
  const onClose = vi.fn();
  render(<SetupWizard ops={ops} deskUrl={DESK} onClose={onClose} />);
  return onClose;
}

const next = () => fireEvent.click(screen.getByRole("button", { name: "Continue" }));

describe("SetupWizard", () => {
  it("renders the five steps from setup_plan, starting with what it found", async () => {
    const { ops, calls } = fakeOps({ setup_plan: () => ({ ok: true, result: PLAN }) });
    wizard(ops);
    expect(await screen.findByText("mosquitto 2.1.2 (from mosquitto -h)")).toBeInTheDocument();
    expect(calls[0]).toEqual({ op: "setup_plan", fields: {} });
    // The Stepper names each of setup's steps (its labels fold away when the row is narrow).
    for (const [i, t] of ["Broker", "Security", "Accounts", "Services", "Phone"].entries()) {
      expect(screen.getByLabelText(`Step ${i + 1}: ${t}`)).toBeInTheDocument();
    }
    // Nothing changes before the person confirms a step: planning is all it did.
    expect(calls.map((c) => c.op)).toEqual(["setup_plan"]);
    expect(screen.getByText(/already done/i)).toBeInTheDocument();
  });

  it("says what a step will change before applying it, then calls setup_apply", async () => {
    let applied: Record<string, unknown> | null = null;
    const { ops, calls } = fakeOps({
      setup_plan: () => ({ ok: true, result: PLAN }),
      setup_apply: (f) => {
        applied = f;
        return {
          ok: true,
          result: { step: f.step, lines: ["Backup: mosquitto.conf.bak-20261019"], problems: [] },
        };
      },
    });
    wizard(ops);
    await screen.findByText("mosquitto 2.1.2 (from mosquitto -h)");
    next();
    expect(
      screen.getByText("Write Volley's Dynamic Security config (the old one is kept as a backup)"),
    ).toBeInTheDocument();
    // The LAN choice is asked first, in setup's words, recommending yes.
    const lan = screen.getByRole("radiogroup", { name: /phone and other devices/i });
    expect(lan).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() => expect(applied).toEqual({ step: "security", lan: true }));
    expect(await screen.findByText("Backup: mosquitto.conf.bak-20261019")).toBeInTheDocument();
    // The plan is read again after a step changed things.
    expect(calls.map((c) => c.op)).toEqual(["setup_plan", "setup_apply", "setup_plan"]);
  });

  it("shows the one-time admin token once", async () => {
    const { ops } = fakeOps({
      setup_plan: () => ({ ok: true, result: PLAN }),
      setup_apply: (f) => ({
        ok: true,
        result: { step: f.step, lines: [], problems: [] },
        ...(f.step === "accounts" ? { secret: { token: TOKEN } } : {}),
      }),
    });
    wizard(ops);
    await screen.findByText("mosquitto 2.1.2 (from mosquitto -h)");
    next();
    next(); // Skip applying Security.
    fireEvent.click(screen.getByRole("button", { name: "Apply this change" }));
    expect(await screen.findByText(TOKEN)).toBeInTheDocument();
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await act(async () => {});
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
    expect(screen.getAllByText(/volley auth token/).length).toBeGreaterThan(0);
  });

  it("ends on a QR code of a one-time phone sign-in link", async () => {
    const { ops, calls } = fakeOps({
      setup_plan: () => ({ ok: true, result: PLAN }),
      signin_link: () => ({
        ok: true,
        result: {
          role: "steer",
          label: "Desk on phone",
          expires_at: "2026-10-19T12:10:00Z",
          link_base: DESK,
        },
        secret: { token: SIGNIN },
      }),
    });
    const onClose = wizard(ops);
    await screen.findByText("mosquitto 2.1.2 (from mosquitto -h)");
    for (let i = 0; i < 4; i++) next();
    fireEvent.click(screen.getByRole("button", { name: "Make the phone link" }));
    const qr = await screen.findByRole("img", { name: /QR code/i });
    const link = `${DESK}#signin=${SIGNIN}`;
    expect(qr.querySelector("path")?.getAttribute("d")).toBe(qrPath(encodeQr(link)));
    expect(calls.at(-1)).toEqual({
      op: "signin_link",
      fields: { role: "steer", label: "Desk on phone", desk_url: DESK },
    });
    expect(screen.getByText(/works once/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("points at `volley setup` when this volleyd cannot run setup", async () => {
    const { ops } = fakeOps({});
    wizard(ops);
    expect(await screen.findByText(/cannot run setup from the Desk/i)).toBeInTheDocument();
    expect(screen.getAllByText("volley setup").length).toBeGreaterThan(0);
    // Not a dead end: the phone link still works from here.
    expect(screen.getByRole("button", { name: "Make the phone link" })).toBeInTheDocument();
  });

  it("says what to do when volleyd does not answer", async () => {
    let n = 0;
    const { ops } = fakeOps({
      setup_plan: () =>
        n++ === 0
          ? { ok: false, error: "volleyd did not answer within 10s", unanswered: true }
          : { ok: true, result: PLAN },
    });
    wizard(ops);
    expect(await screen.findByText(/did not answer/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("mosquitto 2.1.2 (from mosquitto -h)")).toBeInTheDocument();
  });
});

describe("the Desk's QR encoder", () => {
  it("matches volley setup's fixture matrix for a sign-in link", () => {
    const fixture = readFileSync(path.resolve(__dirname, "fixtures/qr-signin-link.txt"), "utf-8");
    const url =
      "http://desk.example:5199/#signin=vly_signin_0123abcd_0123456789abcdef0123456789abcdef";
    expect(matrixText(encodeQr(url))).toBe(fixture);
  });

  it("draws one unit square per dark module inside the quiet zone", () => {
    const qr = encodeQr("a");
    const dark = qr.matrix.flat().filter(Boolean).length;
    const d = qrPath(qr);
    expect(d.match(/M/g)).toHaveLength(dark);
    expect(d.startsWith("M2 2h1v1h-1z")).toBe(true);
  });
});
