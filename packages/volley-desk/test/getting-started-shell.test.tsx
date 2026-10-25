import { readFileSync } from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GettingStarted } from "../src/getting-started/GettingStarted";
import type { SceneId } from "../src/getting-started/art";
import { __resetArtMapForTests } from "../src/getting-started/art/assetMap";
import type { Summary } from "../src/getting-started/state";
import { STEPS, type WizardContext } from "../src/getting-started/steps";
import { initialState } from "../src/store/reducer";
import { fakeOps } from "./helpers/auth-ops";

const RAIL = [
  ["Welcome", "What Volley does"],
  ["This computer", "Install and check"],
  ["Your machines", "Add more computers"],
  ["Repos", "GitHub and projects"],
  ["People", "Accounts and roles"],
  ["Access", "Reach it from anywhere"],
  ["Done", "You're good to go"],
] as const;

const EMPTY: Summary = { machines: [], repos: [], people: [] };

beforeEach(() => {
  __resetArtMapForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
});

function mount(initial: SceneId = "welcome", summary: Summary = EMPTY) {
  const ctx: WizardContext = {
    ops: fakeOps({}).ops,
    control: null,
    state: initialState(),
    deskUrl: "http://desk.example:5199/",
    identity: "admin-0123abcd",
    openSettings: vi.fn(),
  };
  const on = {
    onStep: vi.fn(),
    setSummary: vi.fn(),
    onClose: vi.fn(),
    onSkip: vi.fn(),
    onFinish: vi.fn(),
  };
  render(<GettingStarted ctx={ctx} initial={initial} summary={summary} {...on} />);
  const dialog = screen.getByRole("dialog", { name: "Getting started" });
  const rail = within(within(dialog).getByRole("navigation", { name: "Setup steps" }));
  const stage = within(dialog);
  return { dialog, rail, stage, on, ctx };
}

const heading = () => screen.getByRole("heading", { level: 2 });
const current = (rail: ReturnType<typeof mount>["rail"]) =>
  rail.getAllByRole("button").find((b) => b.getAttribute("aria-current") === "step");

describe("Getting started: the shell", () => {
  it("registers the seven steps in order", () => {
    expect(STEPS.map((s) => s.id)).toEqual([
      "welcome",
      "this-computer",
      "machines",
      "repos",
      "people",
      "access",
      "done",
    ]);
  });

  it("opens on Welcome with the rail, the eyebrow, the copy, the art and Let's go", () => {
    const { rail, stage, dialog } = mount();
    const buttons = rail.getAllByRole("button");
    expect(buttons).toHaveLength(7);
    RAIL.forEach(([title, sub], i) => {
      expect(buttons[i]).toHaveTextContent(title);
      expect(buttons[i]).toHaveTextContent(sub);
    });
    expect(current(rail)).toHaveTextContent("Welcome");
    expect(stage.getByText("Getting started", { selector: ".gs-eyebrow" })).toBeInTheDocument();
    expect(heading()).toHaveTextContent("Let's get your first wave in the air.");
    expect(
      stage.getByText(/Volley coordinates your development waves across your repos/),
    ).toHaveTextContent(
      "Volley coordinates your development waves across your repos: it hands GitHub issues to Claude agents, reviews their work, and merges what passes. This takes about ten minutes. Nothing changes until you say so.",
    );
    expect(dialog.querySelector('[data-scene="welcome"]')).not.toBeNull();
    const card = stage.getByRole("list", { name: "You'll set up" });
    expect(within(card).getAllByRole("listitem")).toHaveLength(5);
    expect(stage.getByRole("button", { name: "Let's go" })).toBeInTheDocument();
    expect(stage.queryByRole("button", { name: "Back" })).toBeNull();
    expect(
      stage.getByText(/Each step shows what it will change before you apply it\./),
    ).toHaveTextContent(
      "Each step shows what it will change before you apply it. Run again any time from Settings › Setup & Security › Getting started.",
    );
  });

  it("walks the stubs to Done, marking reached steps done, and Back steps back", () => {
    const { rail, stage, on, dialog } = mount();
    fireEvent.click(stage.getByRole("button", { name: "Let's go" }));
    expect(on.onStep).toHaveBeenLastCalledWith("this-computer");
    expect(stage.getByText("Step 1 of 6", { selector: ".gs-eyebrow" })).toBeInTheDocument();
    expect(stage.getByText("This step is on its way.")).toBeInTheDocument();
    expect(dialog.querySelector('[data-scene="this-computer"]')).not.toBeNull();
    expect(current(rail)).toHaveTextContent("This computer");
    expect(rail.getAllByRole("button")[0]?.querySelector(".gs-badge--done")).not.toBeNull();

    for (const n of [2, 3, 4, 5]) {
      fireEvent.click(stage.getByRole("button", { name: "Continue" }));
      expect(stage.getByText(`Step ${n} of 6`, { selector: ".gs-eyebrow" })).toBeInTheDocument();
    }
    fireEvent.click(stage.getByRole("button", { name: "Continue" }));
    expect(heading()).toHaveTextContent("You're good to go!");
    expect(stage.getByText("Step 6 of 6", { selector: ".gs-eyebrow" })).toBeInTheDocument();
    expect(current(rail)).toHaveTextContent("Done");

    fireEvent.click(stage.getByRole("button", { name: "Back" }));
    expect(current(rail)).toHaveTextContent("Access");
    expect(on.onStep).toHaveBeenLastCalledWith("access");
  });

  it("Done lists the summary, unknown values as —, and Open the Desk finishes", () => {
    const { stage, on } = mount("done", {
      machines: ["studio", "laptop"],
      repos: [],
      people: [{ name: "sam", role: "steer" }],
      network: "tailscale",
    });
    const list = stage.getByLabelText("Summary");
    const value = (label: string) => {
      const dt = within(list).getByText(label, { selector: "dt" });
      return dt.nextElementSibling?.textContent;
    };
    expect(value("Computers")).toBe("studio, laptop");
    expect(value("Connected by")).toBe("—");
    expect(value("Repos")).toBe("—");
    expect(value("People")).toBe("sam (steer)");
    expect(value("Away from home")).toBe("Tailscale");
    fireEvent.click(stage.getByRole("button", { name: "Open the Desk" }));
    expect(on.onFinish).toHaveBeenCalledOnce();
  });

  it("the rail jumps to a reached step; an unreached one is disabled", () => {
    const { rail, stage } = mount("repos");
    const buttons = rail.getAllByRole("button");
    expect(buttons[4]).toBeDisabled();
    expect(buttons[6]).toBeDisabled();
    expect(buttons[1]).toBeEnabled();
    fireEvent.click(buttons[1] as HTMLElement);
    expect(current(rail)).toHaveTextContent("This computer");
    // Repos was reached before: still a jump away.
    expect(buttons[3]).toBeEnabled();
    fireEvent.click(buttons[3] as HTMLElement);
    expect(stage.getByText("Step 3 of 6", { selector: ".gs-eyebrow" })).toBeInTheDocument();
  });

  it("Escape and the close button pause at the current step; Skip for now skips", () => {
    const { dialog, stage, on } = mount("machines");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(on.onClose).toHaveBeenLastCalledWith("machines");
    fireEvent.click(stage.getByRole("button", { name: "Close Getting started" }));
    expect(on.onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(stage.getByRole("button", { name: "Skip for now" }));
    expect(on.onSkip).toHaveBeenCalledOnce();
  });

  it("Welcome has its own Skip for now", () => {
    const { stage, on } = mount();
    const skips = stage.getAllByRole("button", { name: "Skip for now" });
    expect(skips).toHaveLength(2);
    fireEvent.click(skips[1] as HTMLElement);
    expect(on.onSkip).toHaveBeenCalledOnce();
  });

  it("lays out as one column with a scrolling badge rail at phone width", () => {
    const css = readFileSync(path.resolve(__dirname, "../src/styles/getting-started.css"), "utf8");
    const phone = css.slice(css.indexOf("@media (max-width: 820px)"));
    expect(phone.length).toBeLessThan(css.length);
    expect(phone).toMatch(/\.gs\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(phone).toMatch(/\.gs-rail ol\s*\{[^}]*overflow-x:\s*auto/);
    expect(phone).toMatch(/\.gs-hero[^{]*\{[^}]*--gs-art:\s*200px/);
  });
});
