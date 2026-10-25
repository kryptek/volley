import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Summary } from "../src/getting-started/state";
import type { WizardContext } from "../src/getting-started/steps";
import { INVITE_POLL_MS, People, inviteCommand } from "../src/getting-started/steps/People";
import { ROLE_WORDS, roleFromWord, wordOfRole } from "../src/getting-started/steps/roleWords";
import type { AuthAnswer } from "../src/store/control";
import { initialState } from "../src/store/reducer";
import { fakeOps } from "./helpers/auth-ops";

const EMPTY: Summary = { machines: [], repos: [], people: [] };
const DESK = "http://desk.example:5199/";
const ME = "admin-0123abcd";
const SIGNIN = `vly_signin_0a1b2c3d_${"a".repeat(32)}`;
const ADMIN = `vly_admin_4e5f6a7b_${"b".repeat(32)}`;

const ACCOUNTS = [
  { name: "volleyd", role: "admin", kind: "service", created: "2026-10-01T00:00:00Z" },
  { name: "desk", role: "steer", kind: "service", created: "2026-10-01T00:00:00Z" },
  { name: "coordinator", role: "steer", kind: "service", created: "2026-10-01T00:00:00Z" },
  { name: "box-a", role: "peer", kind: "machine", created: "2026-10-02T00:00:00Z" },
  {
    name: "steer-1a2b3c4d",
    role: "steer",
    kind: "device",
    created: "2026-10-03T00:00:00Z",
    label: "Person A",
    last_seen: new Date(Date.now() - 120_000).toISOString(),
  },
  {
    name: ME,
    role: "admin",
    kind: "device",
    created: "2026-10-01T00:00:00Z",
    label: "Desk on Firefox",
  },
  { name: "watch-5e6f7a8b", role: "watch", kind: "device", created: "2026-10-04T00:00:00Z" },
];

type Handler = (fields: Record<string, unknown>) => AuthAnswer | Promise<AuthAnswer>;

function mount(handlers: Record<string, Handler> = {}, summary: Summary = EMPTY) {
  const { ops, calls } = fakeOps({
    account_list: () => ({
      ok: true,
      result: { accounts: ACCOUNTS, seen_since: "2026-10-01T00:00:00Z" },
    }),
    signin_link: (f) => ({
      ok: true,
      result: {
        role: f.role,
        label: f.label,
        expires_at: "2026-10-25T12:10:00Z",
        link_base: DESK,
      },
      secret: { token: SIGNIN },
    }),
    admin_token: () => ({
      ok: true,
      result: { token_id: "4e5f6a7b", expires_at: "2026-10-25T12:10:00Z" },
      secret: { token: ADMIN },
    }),
    ...handlers,
  });
  const ctx: WizardContext = {
    ops,
    control: null,
    state: initialState(),
    deskUrl: DESK,
    identity: ME,
    openSettings: vi.fn(),
  };
  const setSummary = vi.fn();
  render(<People ctx={ctx} summary={summary} setSummary={setSummary} onContinue={vi.fn()} />);
  return { calls, setSummary };
}

const table = () => screen.getByRole("table", { name: "People" });
const rows = () => within(table()).getAllByRole("row").slice(1);

async function settle() {
  await act(async () => {});
}

async function invite(name: string, role?: "Standard" | "Superuser" | "Viewer") {
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: name } });
  if (role) fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${role}`) }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
  });
}

describe("role words", () => {
  it("maps the wizard's words onto the account roles that exist", () => {
    expect(roleFromWord("Superuser")).toBe("admin");
    expect(roleFromWord("Standard")).toBe("steer");
    expect(roleFromWord("Viewer")).toBe("watch");
    expect(wordOfRole("admin")).toBe("Superuser");
    expect(wordOfRole("peer")).toBeNull();
    expect(ROLE_WORDS.map((w) => w.word)).toEqual(["Standard", "Superuser", "Viewer"]);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the invite's terminal command", () => {
  it("escapes what a shell would expand inside the double quotes", () => {
    expect(inviteCommand("steer", 'P$(id) `x` \\ "q" $HOME')).toBe(
      'volley auth signin-link --role steer --label "P\\$(id) \\`x\\` \\\\ \\"q\\" \\$HOME"',
    );
  });
});

describe("Getting started › People: the table", () => {
  it("lists You first, then each person's account; service and machine accounts are hidden", async () => {
    const { calls } = mount();
    await settle();
    expect(calls[0]?.op).toBe("account_list");
    const r = rows();
    expect(r).toHaveLength(3);
    const [you, a, b] = r.map((x) => within(x));
    expect(you?.getByText("You")).toBeInTheDocument();
    expect(you?.getByText(ME)).toBeInTheDocument();
    expect(you?.getByText("superuser · admin")).toBeInTheDocument();
    expect(a?.getByText("Person A")).toBeInTheDocument();
    expect(a?.getByText("standard · steer")).toBeInTheDocument();
    expect(a?.getByText("2m ago")).toBeInTheDocument();
    expect(a?.getByText("device")).toBeInTheDocument();
    // No label: the account's name.
    expect(b?.getByText("watch-5e6f7a8b")).toBeInTheDocument();
    expect(b?.getByText("viewer · watch")).toBeInTheDocument();
    expect(b?.getByText("never")).toBeInTheDocument();
    const text = table().textContent ?? "";
    for (const hidden of ["volleyd", "coordinator", "box-a"]) expect(text).not.toContain(hidden);
  });
});

describe("Getting started › People: invite links", () => {
  it("Standard (the default) sends signin_link with the name and renders the link, Copy and a QR", async () => {
    const { calls, setSummary } = mount();
    await settle();
    expect(screen.getByRole("radio", { name: /^Standard/ })).toBeChecked();
    await invite("Person B");
    expect(calls.find((c) => c.op === "signin_link")?.fields).toEqual({
      role: "steer",
      label: "Person B",
      desk_url: DESK,
    });
    const link = `${DESK}#signin=${SIGNIN}`;
    expect(screen.getByText(link)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Copy/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "QR code of Person B's invite link" })).toBeVisible();
    expect(
      screen.getByText(
        "The link signs them in once on any device, phone included, and then expires.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/shown once/)).toBeNull();
    // The table gains a pending row until the account appears.
    const pending = rows().map((r) => r.textContent ?? "");
    expect(pending.some((t) => t.includes("Person B") && t.includes("invite link made"))).toBe(
      true,
    );
    expect(setSummary).toHaveBeenCalledWith({ people: [{ name: "Person B", role: "steer" }] });
  });

  it("Viewer sends signin_link with role watch", async () => {
    const { calls, setSummary } = mount();
    await settle();
    await invite("Person B", "Viewer");
    expect(calls.find((c) => c.op === "signin_link")?.fields).toMatchObject({ role: "watch" });
    expect(setSummary).toHaveBeenCalledWith({ people: [{ name: "Person B", role: "watch" }] });
  });

  it("Superuser sends admin_token and renders the #signin= link, shown once", async () => {
    const { calls, setSummary } = mount();
    await settle();
    await invite("Person B", "Superuser");
    expect(calls.some((c) => c.op === "signin_link")).toBe(false);
    expect(calls.find((c) => c.op === "admin_token")).toBeDefined();
    expect(screen.getByText(`${DESK}#signin=${ADMIN}`)).toBeInTheDocument();
    expect(screen.getByText(/shown once and signs one browser in as admin/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "QR code of Person B's invite link" })).toBeVisible();
    expect(setSummary).toHaveBeenCalledWith({ people: [{ name: "Person B", role: "admin" }] });
  });

  it("keeps the people already in the summary", async () => {
    const { setSummary } = mount({}, { ...EMPTY, people: [{ name: "Person A", role: "steer" }] });
    await settle();
    await invite("Person B");
    expect(setSummary).toHaveBeenCalledWith({
      people: [
        { name: "Person A", role: "steer" },
        { name: "Person B", role: "steer" },
      ],
    });
  });

  it("turns the invite's row into the redeemed account, named <role>-<token id>, and stops polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let redeemed = false;
    const { calls } = mount({
      account_list: () => ({
        ok: true,
        result: {
          accounts: redeemed
            ? [
                ...ACCOUNTS,
                {
                  name: "steer-0a1b2c3d",
                  role: "steer",
                  kind: "device",
                  created: "2026-10-25T12:01:00Z",
                  label: "Desk on Firefox",
                },
              ]
            : ACCOUNTS,
          seen_since: "2026-10-01T00:00:00Z",
        },
      }),
    });
    await settle();
    await invite("Person B");
    expect(rows().some((r) => r.textContent?.includes("invite link made"))).toBe(true);
    redeemed = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INVITE_POLL_MS);
    });
    const texts = rows().map((r) => r.textContent ?? "");
    expect(texts.some((t) => t.includes("invite link made"))).toBe(false);
    // The redeemed account carries the device's label; the row shows the invite's name too.
    const row = texts.find((t) => t.includes("Desk on Firefox") && t.includes("Person B"));
    expect(row).toBeDefined();
    const lists = () => calls.filter((c) => c.op === "account_list").length;
    const before = lists();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INVITE_POLL_MS * 3);
    });
    expect(lists()).toBe(before);
  });

  it("an unknown op answer renders the terminal command, never a dead end", async () => {
    const unknown = (op: string) => () => ({ ok: false, error: `unknown op '${op}'` });
    const { setSummary } = mount({
      account_list: unknown("account_list"),
      signin_link: unknown("signin_link"),
    });
    await settle();
    await invite("Person B");
    expect(
      screen.getByText('volley auth signin-link --role steer --label "Person B"'),
    ).toBeInTheDocument();
    expect(setSummary).not.toHaveBeenCalled();
  });

  it("needs a name before it makes a link", async () => {
    mount();
    await settle();
    expect(screen.getByRole("button", { name: "Create invite link" })).toBeDisabled();
  });
});
