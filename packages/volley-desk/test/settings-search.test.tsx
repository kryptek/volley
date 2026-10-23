import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LOOK0 } from "../src/look/useLook";
import { SettingsWindow } from "../src/settings/SettingsWindow";
import { matchSections } from "../src/settings/sections";

const keys = (q: string) => matchSections(q).map((s) => s.key);

describe("matchSections", () => {
  it("matches labels and keywords, ignoring case and spaces around the query", () => {
    expect(keys("tunnel")).toEqual(["machines"]);
    expect(keys("ceiling")).toEqual(["supervisor"]);
    // Supervisor's rows are searched too: Other › Background wait max.
    expect(keys("  Background ")).toEqual(["appearance", "supervisor"]);
    expect(keys("ABOUT")).toEqual(["about"]);
    expect(keys("")).toHaveLength(11);
  });

  it("finds Sound by its words; 'theme' still finds Appearance too", () => {
    expect(keys("quiet")).toEqual(["sound"]);
    expect(keys("rationale")).toEqual(["autopilot"]);
    expect(keys("vibrate")).toEqual(["sound"]);
    expect(keys("audition")).toEqual(["sound"]);
    expect(keys("theme")).toEqual(["sound", "appearance"]);
    expect(keys("zzz")).toEqual([]);
  });

  it("finds the Fleet's controls: Machines for repair and drain, Supervisor for lease pools", () => {
    expect(keys("repair")).toEqual(["machines"]);
    expect(keys("drain")).toEqual(["machines"]);
    expect(keys("lease pools")).toEqual(["supervisor"]);
  });

  it("finds Repositories by repository, github and clone", () => {
    expect(keys("repository")).toEqual(["repos"]);
    expect(keys("GitHub")).toEqual(["repos"]);
    expect(keys("clone")).toEqual(["repos"]);
    expect(keys("repositories")).toEqual(["repos"]);
  });
});

describe("the sidebar search", () => {
  const renderWindow = () =>
    render(
      <SettingsWindow
        look={LOOK0}
        setLook={() => {}}
        notify={{ enabled: false, sound: true, on: [] }}
        setNotify={() => {}}
        webgl
        identity="desk"
        demo={false}
        config={null}
        transport={null}
        onArrange={() => {}}
        onClose={() => {}}
      />,
    );
  const search = () => screen.getByRole("searchbox", { name: "Search settings" });
  const listed = () =>
    within(screen.getByRole("navigation", { name: "Settings sections" }))
      .queryAllByRole("button")
      .map((b) => b.textContent);

  it("typing 'tunnel' shows only Machines; 'ceiling' shows only Supervisor", () => {
    renderWindow();
    fireEvent.change(search(), { target: { value: "tunnel" } });
    expect(listed()).toEqual(["Machines"]);
    fireEvent.change(search(), { target: { value: "ceiling" } });
    expect(listed()).toEqual(["Supervisor"]);
    fireEvent.change(search(), { target: { value: "" } });
    expect(listed()).toHaveLength(11);
  });

  it("says so when nothing matches, and keeps the open section on screen", () => {
    renderWindow();
    fireEvent.change(search(), { target: { value: "zzz" } });
    expect(listed()).toEqual([]);
    expect(screen.getByText(/No settings match/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("General");
  });
});
