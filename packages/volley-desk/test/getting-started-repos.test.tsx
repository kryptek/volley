import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Summary } from "../src/getting-started/state";
import type { StepProps, WizardContext } from "../src/getting-started/steps";
import { GH_SIGNIN_COMMAND, Repos } from "../src/getting-started/steps/Repos";
import type { AuthAnswer } from "../src/store/control";
import { initialState } from "../src/store/reducer";
import type { MachinePayload } from "../src/store/types";
import { fakeOps } from "./helpers/auth-ops";
import { machine, machines, repoConfig } from "./helpers/repos";

const SLUG = "example-org/example-repo";
const EMPTY: Summary = { machines: [], repos: [], people: [] };
const FOLDER = "/srv/example-repo";

type Handler = (fields: Record<string, unknown>) => AuthAnswer | Promise<AuthAnswer>;

function mount(
  opts: {
    gh?: NonNullable<MachinePayload["auth"]>["gh"] | null;
    handlers?: Record<string, Handler>;
    summary?: Summary;
  } = {},
) {
  const fleet = machines();
  const hub = fleet.hub as MachinePayload;
  if (opts.gh !== null) {
    hub.auth = { gh: opts.gh ?? "ok", claude: "signed_in", trust: "ok" };
  }
  const { ops, calls } = fakeOps({
    repo_add: (f) => ({
      ok: true,
      result: {
        slug: f.slug,
        url: `https://github.com/${String(f.slug)}`,
        visibility: "private",
        machines: Array.isArray(f.machines) ? f.machines : ["hub", "box-a", "box-b"],
        status: [],
      },
    }),
    ...opts.handlers,
  });
  const state = { ...initialState(), config: repoConfig(), machines: fleet };
  const ctx: WizardContext = {
    ops,
    control: null,
    state,
    deskUrl: "http://desk.example:5199/",
    identity: ops.identity,
    openSettings: vi.fn(),
  };
  const setSummary = vi.fn();
  const props: StepProps = {
    ctx,
    summary: opts.summary ?? EMPTY,
    setSummary,
    onContinue: vi.fn(),
  };
  const r = render(<Repos {...props} />);
  const rerender = (more: Partial<StepProps>) => r.rerender(<Repos {...props} {...more} />);
  return { calls, setSummary, rerender, ctx, fleet };
}

const card = () => within(screen.getByRole("region", { name: "GitHub" }));

afterEach(() => {
  vi.useRealTimers();
});

describe("Getting started › Repos: the GitHub card", () => {
  it("reads signed in from the supervisor's record (`auth.gh: ok`)", () => {
    mount({ gh: "ok" });
    expect(card().getByText("✓ Signed in on hub")).toBeInTheDocument();
    expect(card().queryByText(GH_SIGNIN_COMMAND)).toBeNull();
  });

  it("counts `no_write` as signed in", () => {
    mount({ gh: "no_write" });
    expect(card().getByText("✓ Signed in on hub")).toBeInTheDocument();
  });

  it("reads not signed in with the command to run on that machine and Check again", () => {
    const { rerender, ctx, fleet } = mount({ gh: "unauthenticated" });
    expect(card().getByText("Not signed in")).toBeInTheDocument();
    expect(card().getByText(GH_SIGNIN_COMMAND)).toBeInTheDocument();
    expect(GH_SIGNIN_COMMAND).toBe("gh auth login --web --git-protocol https && gh auth setup-git");
    expect(card().getByText(/Run this in a terminal on hub/)).toBeInTheDocument();

    fireEvent.click(card().getByRole("button", { name: "Check again" }));
    expect(card().getByText(/Waiting for hub's next check/)).toBeInTheDocument();

    // The next record says signed in.
    const hub = {
      ...fleet.hub,
      last_seen: new Date().toISOString(),
      auth: { gh: "ok", claude: "signed_in", trust: "ok" },
    } as MachinePayload;
    rerender({ ctx: { ...ctx, state: { ...ctx.state, machines: { ...fleet, hub } } } });
    expect(card().getByText("✓ Signed in on hub")).toBeInTheDocument();
  });

  it("reads `missing` (no gh) as not signed in", () => {
    mount({ gh: "missing" });
    expect(card().getByText("Not signed in")).toBeInTheDocument();
  });
});

describe("Getting started › Repos: Add a repo", () => {
  it("switches the form between From GitHub and A folder on a computer", () => {
    mount();
    const github = screen.getByRole("tab", { name: "From GitHub" });
    const folder = screen.getByRole("tab", { name: "A folder on a computer" });
    expect(github).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("group", { name: "Clone it on" })).toBeInTheDocument();
    fireEvent.click(folder);
    expect(folder).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("group", { name: "Clone it on" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Folder" })).toBeInTheDocument();
    fireEvent.click(github);
    expect(screen.getByRole("group", { name: "Clone it on" })).toBeInTheDocument();
  });

  it("From GitHub: sends repo_add with the ticked machines and shows what GitHub said", async () => {
    const { calls, setSummary } = mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Repository (owner/name)" }), {
      target: { value: SLUG },
    });
    // Every machine starts ticked: untick box-b, leaving two.
    fireEvent.click(screen.getByRole("checkbox", { name: "box-b" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    });
    expect(calls.find((c) => c.op === "repo_add")?.fields).toEqual({
      slug: SLUG,
      machines: ["hub", "box-a"],
    });
    expect(screen.getByText("✓ Found on GitHub · private")).toBeInTheDocument();
    const added = within(screen.getByRole("list", { name: "Repos added" }));
    expect(added.getByText(SLUG)).toBeInTheDocument();
    expect(setSummary).toHaveBeenCalledWith({ repos: [SLUG] });
  });

  it("From GitHub: shows volleyd's refusal as it said it", async () => {
    const { setSummary } = mount({
      handlers: {
        repo_add: () => ({ ok: false, error: "GraphQL: Could not resolve to a Repository" }),
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Repository (owner/name)" }), {
      target: { value: SLUG },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "GraphQL: Could not resolve to a Repository",
    );
    expect(setSummary).not.toHaveBeenCalled();
  });

  it("keeps the repos already in the summary and adds a new one once", async () => {
    const { setSummary } = mount({ summary: { ...EMPTY, repos: ["example-org/other"] } });
    expect(
      within(screen.getByRole("list", { name: "Repos added" })).getByText("example-org/other"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Repository (owner/name)" }), {
      target: { value: SLUG },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    });
    expect(setSummary).toHaveBeenCalledWith({ repos: ["example-org/other", SLUG] });
  });

  it("A folder: lists paired machines only and says how the supervisor's own clones are added", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "A folder on a computer" }));
    const picker = screen.getByRole("combobox", { name: "Computer" });
    const names = within(picker)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(names).toEqual(["box-a", "box-b"]);
    expect(screen.getByText(/hub's own clones are added by path in the wave file/)).toBeVisible();
  });

  it("A folder: a found clone fills the slug, shows the folder line, and adds with its path", async () => {
    vi.useFakeTimers();
    const { calls, setSummary } = mount({
      handlers: {
        repo_probe: (f) => ({
          ok: true,
          result: {
            machine: f.machine,
            path: f.path,
            state: "found",
            root: FOLDER,
            origin: `https://github.com/${SLUG}.git`,
            slug: SLUG,
          },
        }),
      },
    });
    fireEvent.click(screen.getByRole("tab", { name: "A folder on a computer" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder" }), {
      target: { value: FOLDER },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(calls.find((c) => c.op === "repo_probe")?.fields).toEqual({
      machine: "box-a",
      path: FOLDER,
    });
    expect(
      screen.getByText(`✓ Folder exists · git clone · origin is ${SLUG} (filled in for you)`),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Repository (owner/name)" })).toHaveValue(SLUG);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    });
    expect(calls.find((c) => c.op === "repo_add")?.fields).toEqual({
      slug: SLUG,
      machines: ["box-a"],
      paths: { "box-a": FOLDER },
    });
    expect(screen.getByText("✓ Found on GitHub · private")).toBeInTheDocument();
    expect(setSummary).toHaveBeenCalledWith({ repos: [SLUG] });
  });

  it.each([
    ["not_git", `${FOLDER} on box-a is not a git clone`],
    ["missing", `No folder at ${FOLDER} on box-a`],
    ["no_origin", `${FOLDER} on box-a has no origin remote`],
  ] as const)("A folder: `%s` blocks Add with the sheet's text", async (state, text) => {
    vi.useFakeTimers();
    mount({
      handlers: {
        repo_probe: (f) => ({
          ok: true,
          result: {
            machine: f.machine,
            path: f.path,
            state,
            ...(state === "no_origin" ? { root: FOLDER } : {}),
          },
        }),
      },
    });
    fireEvent.click(screen.getByRole("tab", { name: "A folder on a computer" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder" }), {
      target: { value: FOLDER },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Repository (owner/name)" }), {
      target: { value: SLUG },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Add repo" })).toBeDisabled();
  });

  it("A folder: without a paired machine it says so and offers no form", () => {
    const { rerender, ctx } = mount();
    rerender({
      ctx: {
        ...ctx,
        state: {
          ...ctx.state,
          config: { ...repoConfig(), hosts: {} },
          machines: { hub: machine("hub", { kind: "supervisor" }) },
        },
      },
    });
    fireEvent.click(screen.getByRole("tab", { name: "A folder on a computer" }));
    expect(screen.getByText(/No computer is paired yet/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Folder" })).toBeNull();
  });
});
