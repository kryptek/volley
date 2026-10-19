import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { encodeQr, matrixText, qrPath } from "../src/lib/qr";
import { SetupWizard } from "../src/settings/SetupWizard";
import type { AuthAnswer, AuthOps } from "../src/store/control";
import { PLAN, fakeOps } from "./helpers/auth-ops";

const TOKEN = "vly_admin_89abcdef_0123456789abcdef0123456789abcdef";
const SIGNIN = "vly_signin_0a1b2c3d_00112233445566778899aabbccddeeff";
const DESK = "http://desk.example:5199/";
/** volleyd's note for a keychain it cannot read (`KEYCHAIN_UNCHECKED` in its setup ops). */
const KEYCHAIN_UNCHECKED =
  "The macOS keychain can't be checked from the Desk; `volley setup` checks it in a terminal (and stores the coordinator's login there if it is missing)";

function wizard(ops: AuthOps, extra: { repair?: boolean } = {}) {
  const onClose = vi.fn();
  render(<SetupWizard ops={ops} deskUrl={DESK} onClose={onClose} {...extra} />);
  return onClose;
}

const next = () => fireEvent.click(screen.getByRole("button", { name: "Continue" }));
const planned = () => screen.findByText("Found your broker");

type Step = (typeof PLAN.steps)[number];
/** PLAN with `step` changed by `edit`. */
const planWith = (step: string, edit: (s: Step) => Record<string, unknown>) => ({
  ...PLAN,
  steps: PLAN.steps.map((s) => (s.step === step ? { ...s, ...edit(s) } : s)),
});

describe("SetupWizard", () => {
  it("opens in its own modal and renders the five steps from setup_plan", async () => {
    const { ops, calls } = fakeOps({ setup_plan: () => ({ ok: true, result: PLAN }) });
    wizard(ops);
    await planned();
    expect(calls[0]).toEqual({ op: "setup_plan", fields: {} });
    expect(screen.getByRole("dialog", { name: "Set up Volley" })).toBeInTheDocument();
    // The Stepper names each of setup's steps (its labels fold away when the row is narrow).
    for (const [i, t] of ["Broker", "Security", "Accounts", "Services", "Phone"].entries()) {
      expect(screen.getByLabelText(`Step ${i + 1}: ${t}`)).toBeInTheDocument();
    }
    // Nothing changes before the person confirms a step: planning is all it did.
    expect(calls.map((c) => c.op)).toEqual(["setup_plan"]);
  });

  it("step 1 is the prototype's grid of what it found, and the promise", async () => {
    const { ops } = fakeOps({ setup_plan: () => ({ ok: true, result: PLAN }) });
    wizard(ops);
    await planned();
    const kv = document.querySelector(".kv");
    if (!(kv instanceof HTMLElement)) throw new Error("no kv grid");
    const grid = within(kv);
    expect(grid.getByText("Broker").nextElementSibling).toHaveTextContent("mosquitto 2.1.2");
    expect(grid.getByText("Listening").nextElementSibling).toHaveTextContent(
      ":1883 refuses anonymous · :9001 refuses anonymous",
    );
    expect(grid.getByText("Agents on it now").nextElementSibling).toHaveTextContent("3 live");
    expect(
      screen.getByText(
        "Nothing changes until you confirm a step. Every file I edit gets a backup next to it.",
      ),
    ).toBeInTheDocument();
  });

  it("closes on the X, on Escape and on a scrim click", async () => {
    const { ops } = fakeOps({ setup_plan: () => ({ ok: true, result: PLAN }) });
    const onClose = wizard(ops);
    await planned();
    fireEvent.click(screen.getByRole("button", { name: "Close setup" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Set up Volley" }), { key: "Escape" });
    const scrim = screen.getByRole("dialog", { name: "Set up Volley" }).parentElement;
    if (scrim === null) throw new Error("no scrim");
    fireEvent.pointerDown(scrim);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("asks the LAN question above the changes, then applies exactly the plan shown", async () => {
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
    await planned();
    next();
    const lan = screen.getByRole("radiogroup", { name: /phone and other devices/i });
    const change = screen.getByText(
      "Write Volley's Dynamic Security config (the old one is kept as a backup)",
    );
    // The question comes first: the changes below it are planned for its answer.
    expect(lan.compareDocumentPosition(change) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(lan).getByRole("radio", { name: /Yes/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() =>
      expect(applied).toEqual({ step: "security", plan_id: "security-1", lan: true }),
    );
    expect(await screen.findByText("Backup: mosquitto.conf.bak-20261019")).toBeInTheDocument();
    // Applying may take a while (a broker restart, the Desk build).
    expect(calls.find((c) => c.op === "setup_apply")?.opts?.timeoutMs).toBe(120_000);
    // The plan is read again after a step changed things.
    expect(calls.map((c) => c.op)).toEqual(["setup_plan", "setup_apply", "setup_plan"]);
  });

  it("another LAN answer asks for the plan again with lan, and that plan is applied", async () => {
    const { ops, calls } = fakeOps({
      setup_plan: (f) => ({
        ok: true,
        result:
          f.lan === false
            ? planWith("security", () => ({
                plan_id: "security-2",
                lan: { planned: false, current: false },
                changes: [{ summary: "Write the config, WebSocket on this machine only" }],
              }))
            : PLAN,
      }),
      setup_apply: (f) => ({ ok: true, result: { step: f.step, lines: [], problems: [] } }),
    });
    wizard(ops);
    await planned();
    next();
    fireEvent.click(screen.getByRole("radio", { name: /No, this machine only/ }));
    expect(
      await screen.findByText("Write the config, WebSocket on this machine only"),
    ).toBeInTheDocument();
    expect(calls[1]).toEqual({ op: "setup_plan", fields: { lan: false } });
    fireEvent.click(screen.getByRole("button", { name: "Apply this change" }));
    await waitFor(() =>
      expect(calls.find((c) => c.op === "setup_apply")?.fields).toEqual({
        step: "security",
        plan_id: "security-2",
        lan: false,
      }),
    );
  });

  it("offers the LAN question even when Security has nothing to change", async () => {
    const { ops } = fakeOps({
      setup_plan: () => ({
        ok: true,
        result: planWith("security", () => ({
          changes: [],
          lan: { planned: false, current: false },
        })),
      }),
    });
    wizard(ops);
    await planned();
    next();
    expect(screen.getByText(/already done/i)).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: /phone and other devices/i }),
    ).toBeInTheDocument();
  });

  it("shows the new plan when volleyd says the plan changed", async () => {
    let n = 0;
    const { ops } = fakeOps({
      setup_plan: () => ({
        ok: true,
        result:
          n++ === 0
            ? PLAN
            : planWith("security", (s) => ({
                plan_id: "security-2",
                changes: [...s.changes, { summary: "Create the Dynamic Security state file" }],
              })),
      }),
      setup_apply: () => ({ ok: false, error: "plan changed: check again" }),
    });
    wizard(ops);
    await planned();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    expect(await screen.findByText(/nothing was applied/)).toBeInTheDocument();
    expect(await screen.findByText("Create the Dynamic Security state file")).toBeInTheDocument();
  });

  it("an unanswered apply offers Check again, and its late answer still shows the token", async () => {
    let late: ((a: AuthAnswer) => void) | undefined;
    const { ops, calls } = fakeOps({
      setup_plan: () => ({ ok: true, result: PLAN }),
      setup_apply: (_f, opts) => {
        late = opts.onLate;
        return { ok: false, error: "volleyd did not answer within 120s", unanswered: true };
      },
    });
    wizard(ops);
    await planned();
    next();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Apply this change" }));
    expect(await screen.findByText(/may still be applying it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(calls.filter((c) => c.op === "setup_plan")).toHaveLength(2));
    // The answer arrives after all: the single-use token is not lost.
    await act(async () =>
      late?.({ ok: true, result: { lines: [], problems: [] }, secret: { token: TOKEN } }),
    );
    expect(await screen.findByText(TOKEN)).toBeInTheDocument();
  });

  it("shows why a change needs a terminal and its command, and never applies it", async () => {
    const terminal = {
      reason: "it needs sudo",
      command: "sudo volley setup --step security --lan",
    };
    const { ops } = fakeOps({
      setup_plan: () => ({
        ok: true,
        result: planWith("security", (s) => ({
          changes: s.changes.map((c) => ({ ...c, terminal })),
        })),
      }),
    });
    wizard(ops);
    await planned();
    next();
    expect(screen.getAllByText(/it needs sudo/)).toHaveLength(2);
    expect(screen.getAllByText("sudo volley setup --step security --lan")).toHaveLength(2);
    // Every change here needs a terminal: nothing to apply from the Desk, so no Apply at all.
    expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
    expect(
      screen.getByText(
        "Every change here needs a terminal; run the command above, then check again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("a keychain volleyd cannot check is a neutral note: no warning, no Apply, no attention badge", async () => {
    const { ops } = fakeOps({
      setup_plan: () => ({
        ok: true,
        result: planWith("accounts", (s) => ({
          found: [
            ...s.found,
            KEYCHAIN_UNCHECKED,
            "An admin account exists (admin account admin-1)",
          ],
          changes: [],
        })),
      }),
    });
    wizard(ops);
    await planned();
    next();
    next();
    const note = screen.getByText(KEYCHAIN_UNCHECKED).closest("li");
    expect(note).toHaveAttribute("data-kind", "note");
    // Not a check that passed, and not a warning either.
    for (const f of [
      "Volley's shared roles are on the broker",
      "An admin account exists (admin account admin-1)",
    ]) {
      expect(screen.getByText(f).closest("li")).toHaveAttribute("data-kind", "found");
    }
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/Already done: nothing to change/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
    next();
    expect(screen.getByLabelText(/^Step 3: Accounts/)).toHaveAttribute("data-status", "complete");
  });

  it("shows the reconnecting notice while the broker restarts, until the plan answers", async () => {
    let n = 0;
    const { ops } = fakeOps({
      setup_plan: () =>
        n++ === 1
          ? { ok: false, error: "volleyd did not answer within 10s", unanswered: true }
          : { ok: true, result: PLAN },
      setup_apply: () => ({
        ok: true,
        result: { lines: ["Wrote mosquitto.conf."], problems: [], restarting: true },
      }),
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      wizard(ops);
      await planned();
      next();
      fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
      expect(await screen.findByText(/reconnecting/)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await waitFor(() => expect(screen.queryByText(/reconnecting/)).not.toBeInTheDocument());
      expect(n).toBe(3);
    } finally {
      vi.useRealTimers();
    }
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
    await planned();
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
    await planned();
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

  it("spends no link while a phone cannot reach the broker (the plan skipped the step)", async () => {
    const { ops } = fakeOps({
      setup_plan: () => ({
        ok: true,
        result: planWith("phone", () => ({
          changes: [],
          skipped: "a phone cannot reach the broker's WebSocket listener at ws://desk.example:9001",
        })),
      }),
    });
    wizard(ops);
    await planned();
    for (let i = 0; i < 4; i++) next();
    expect(screen.getByRole("button", { name: "Make the phone link" })).toBeDisabled();
    expect(screen.getByText(/cannot reach the broker's WebSocket listener/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to Security" }));
    expect(
      screen.getByRole("radiogroup", { name: /phone and other devices/i }),
    ).toBeInTheDocument();
  });

  it("asks before making another link while one is pending or the phone is signed in", async () => {
    const { ops, calls } = fakeOps({
      setup_plan: () => ({
        ok: true,
        result: planWith("phone", () => ({
          changes: [],
          found: ["A phone sign-in link is pending until 2026-10-19T12:10:00Z"],
        })),
      }),
      signin_link: () => ({
        ok: true,
        result: { link_base: DESK, expires_at: "2026-10-19T12:20:00Z" },
        secret: { token: SIGNIN },
      }),
    });
    wizard(ops);
    await planned();
    for (let i = 0; i < 4; i++) next();
    fireEvent.click(screen.getByRole("button", { name: "Make another link" }));
    expect(calls.some((c) => c.op === "signin_link")).toBe(false);
    expect(screen.getByText(/already has a link waiting or is signed in/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Make another link" }));
    expect(await screen.findByRole("img", { name: /QR code/i })).toBeInTheDocument();
  });

  it("Run setup again plans and applies as a repair", async () => {
    const { ops, calls } = fakeOps({
      setup_plan: () => ({ ok: true, result: PLAN }),
      setup_apply: (f) => ({ ok: true, result: { step: f.step, lines: [], problems: [] } }),
    });
    wizard(ops, { repair: true });
    await planned();
    expect(calls[0]).toEqual({ op: "setup_plan", fields: { repair: true } });
    next();
    fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() =>
      expect(calls.find((c) => c.op === "setup_apply")?.fields).toEqual({
        step: "security",
        plan_id: "security-1",
        lan: true,
        repair: true,
      }),
    );
  });

  it("Run setup again: the phone step's copy agrees with its button", async () => {
    const { ops, calls } = fakeOps({
      setup_plan: () => ({
        ok: true,
        result: planWith("phone", () => ({
          found: [
            'Skipped under --repair (`volley auth signin-link --role steer --label "Desk on phone"` issues a link any time)',
          ],
          changes: [],
        })),
      }),
      signin_link: () => ({
        ok: true,
        result: { link_base: DESK, expires_at: "2026-10-19T10:10:00Z" },
        secret: { token: SIGNIN },
      }),
    });
    wizard(ops, { repair: true });
    await planned();
    for (let i = 0; i < 4; i++) next();
    // Not "Skipped" beside a live button: a repair makes no link on its own, the button makes one.
    expect(screen.queryByText(/Skipped under --repair/)).toBeNull();
    expect(
      screen.getByText(
        "Run setup again checks and fixes; it makes no phone link by itself. If your phone needs one, make it here.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Make a phone link" }));
    expect(await screen.findByRole("img", { name: /QR code/i })).toBeInTheDocument();
    expect(calls.filter((c) => c.op === "signin_link")).toHaveLength(1);
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
    expect(await planned()).toBeInTheDocument();
  });

  it("shows the plan under StrictMode (its effects run, are cleaned up and run again)", async () => {
    const { ops } = fakeOps({ setup_plan: () => ({ ok: true, result: PLAN }) });
    render(
      <StrictMode>
        <SetupWizard ops={ops} deskUrl={DESK} onClose={() => {}} />
      </StrictMode>,
    );
    expect(await planned()).toBeInTheDocument();
  });

  it("never spins on a plan request that fails outright: it offers Try again", async () => {
    let n = 0;
    const { ops } = fakeOps({
      setup_plan: () => {
        if (n++ === 0) throw new Error("the connection closed");
        return { ok: true, result: PLAN };
      },
    });
    wizard(ops);
    expect(await screen.findByText(/the connection closed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await planned()).toBeInTheDocument();
  });

  it("does not tick a step left with changes only a terminal can make", async () => {
    const terminal = {
      reason: "it needs sudo",
      command: "sudo volley setup --step security --no-lan",
    };
    const { ops } = fakeOps({
      setup_plan: () => ({
        ok: true,
        result: planWith("security", (s) => ({
          changes: s.changes.map((c) => ({ ...c, terminal })),
        })),
      }),
    });
    wizard(ops);
    await planned();
    next();
    next();
    const badge = (n: number, t: string) => screen.getByLabelText(new RegExp(`^Step ${n}: ${t}`));
    // Broker is done; Security still waits on a terminal, so it asks for attention instead.
    expect(badge(1, "Broker")).toHaveAttribute("data-status", "complete");
    expect(badge(2, "Security")).toHaveAttribute("data-status", "attention");
    expect(screen.getByLabelText(/^Step 2: Security/)).toHaveAccessibleName(
      "Step 2: Security, needs a terminal",
    );
    expect(badge(3, "Accounts")).toHaveAttribute("data-status", "active");
    expect(badge(4, "Services")).toHaveAttribute("data-status", "upcoming");
  });
});

/** volley-cli's QR tests: its fixture and its independent decoder, run over the Desk's copy. */
const CLI_QR = path.resolve(__dirname, "../../volley-cli/test/setup");

interface Decoder {
  decodeMatrix(m: boolean[][]): { text: string; version: number; mask: number };
  parseMatrix(text: string): boolean[][];
}

describe("the Desk's QR encoder", () => {
  it("matches volley setup's own fixture matrix for a sign-in link", async () => {
    const fixture = readFileSync(path.join(CLI_QR, "fixtures/qr-signin-link.txt"), "utf-8");
    const url =
      "http://desk.example:5199/#signin=vly_signin_0123abcd_0123456789abcdef0123456789abcdef";
    expect(matrixText(encodeQr(url))).toBe(fixture);
    const { decodeMatrix, parseMatrix } = (await import(
      /* @vite-ignore */ path.join(CLI_QR, "qr-decode.ts")
    )) as Decoder;
    expect(decodeMatrix(parseMatrix(fixture)).text).toBe(url);
  });

  it("decodes back with volley setup's decoder, for every mask and size up to version 10", async () => {
    const { decodeMatrix } = (await import(
      /* @vite-ignore */ path.join(CLI_QR, "qr-decode.ts")
    )) as Decoder;
    for (const text of ["a", "é ünïcode ✓", "x".repeat(84), "y".repeat(85), "z".repeat(213)]) {
      for (let mask = 0; mask < 8; mask++) {
        const qr = encodeQr(text, { mask });
        const d = decodeMatrix(qr.matrix);
        expect(d.text).toBe(text);
        expect(d.mask).toBe(mask);
      }
    }
    expect(encodeQr("z".repeat(213)).version).toBe(10);
  });

  it("draws one unit square per dark module inside the quiet zone", () => {
    const qr = encodeQr("a");
    const dark = qr.matrix.flat().filter(Boolean).length;
    const d = qrPath(qr);
    expect(d.match(/M/g)).toHaveLength(dark);
    expect(d.startsWith("M2 2h1v1h-1z")).toBe(true);
  });
});
