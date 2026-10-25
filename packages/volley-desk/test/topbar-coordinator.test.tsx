import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState, reduceAll } from "../src/store/reducer";
import type { CoordinatorRolePayload, DeskMessage, DeskState } from "../src/store/types";
import { TopBar } from "../src/topbar/TopBar";
import { NOW, env } from "./helpers/desk-msgs";

const LINK = "https://claude.ai/code/session_fake01";

const federation = (p: CoordinatorRolePayload | null): DeskMessage => ({
  topic: "volley/_system/federation/coordinator",
  envelope: p === null ? null : env("volleyd", "_system/federation", "coordinator", p, NOW),
  receivedAt: NOW,
  retained: true,
});

const role = (over: Partial<CoordinatorRolePayload> = {}): CoordinatorRolePayload => ({
  machine: "box-a",
  name: "coord-test",
  state: "running",
  since: new Date(NOW).toISOString(),
  restarts: 0,
  ...over,
});

const bar = (state: DeskState, demo = false) =>
  render(
    <TopBar
      state={state}
      connection="connected"
      demo={demo}
      needsYou={0}
      onNeedsYou={() => {}}
      coordsOpen={false}
      onToggleCoords={() => {}}
      notify={{ enabled: false, sound: false, on: [] } as never}
      setNotify={() => {}}
      now={NOW}
    />,
  );

describe("the top bar's Open coordinator", () => {
  it("running with a link: a link that opens it in a new tab", () => {
    bar(reduceAll(initialState(), [federation(role({ session_url: LINK }))]));
    const a = screen.getByRole("link", { name: /open coordinator/i });
    expect(a).toHaveAttribute("href", LINK);
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("starting: disabled, the machine in its label and tooltip", () => {
    bar(reduceAll(initialState(), [federation(role({ state: "starting" }))]));
    const b = screen.getByRole("button", { name: /coordinator starting on box-a/i });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute("title", "Coordinator starting on box-a…");
    expect(screen.queryByRole("link", { name: /open coordinator/i })).toBeNull();
  });

  it("nothing retained: disabled, No coordinator running", () => {
    bar(reduceAll(initialState(), [federation(null)]));
    const b = screen.getByRole("button", { name: /no coordinator running/i });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute("title", "No coordinator running");
  });

  it("is hidden in demo mode", () => {
    bar(reduceAll(initialState(), [federation(role({ session_url: LINK }))]), true);
    expect(screen.queryByRole("link", { name: /open coordinator/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /open coordinator/i })).toBeNull();
  });
});
