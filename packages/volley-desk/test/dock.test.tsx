import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../src/App";
import { LOOK_STORAGE_KEY } from "../src/look/useLook";
import { DeskStoreProvider } from "../src/store/context";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none", autoArrange: false }));
});

const renderApp = () =>
  render(
    <DeskStoreProvider demo>
      <App />
    </DeskStoreProvider>,
  );
const dock = () => within(screen.getByRole("toolbar", { name: "Dock" }));

describe("the dock", () => {
  it("has exactly six items, in order", () => {
    renderApp();
    expect(
      dock()
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual([
      "Wave coordinators",
      "Hide tethers",
      "Arrange & fit",
      "Zoom in",
      "Zoom out",
      "Settings",
    ]);
  });

  it("its panel is lifted and lit like the Desk's windows (D10)", () => {
    const css = readFileSync(join(__dirname, "../src/styles/look.css"), "utf8").replace(
      /\s+/g,
      " ",
    );
    const at = css.indexOf(".dock-wrap .dock {");
    expect(at).toBeGreaterThanOrEqual(0);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toMatch(/background: linear-gradient\( ?160deg/);
    expect(rule).toMatch(/inset 0 1px 0 rgba\(255, 255, 255, 0\.18\)/);
    expect(rule).toMatch(/var\(--win-shadow\)/);
  });

  it("no longer carries Appearance or auto-arrange, and the aside is gone", () => {
    renderApp();
    expect(dock().queryByRole("button", { name: "Appearance" })).toBeNull();
    expect(dock().queryByRole("button", { name: /Auto-arrange/ })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Appearance" })).toBeNull();
  });

  it("the coordinators badge still shows what needs you", () => {
    const { container } = renderApp();
    const pill = container.querySelector(".topbar .ny-pill")?.textContent ?? "";
    const n = pill.match(/(\d+) needs? you/)?.[1];
    expect(n).toBeDefined();
    expect(dock().getByRole("button", { name: "Wave coordinators" })).toHaveTextContent(n ?? "");
  });

  it("tethers toggle from the dock; Settings opens and closes the Settings window", () => {
    const { container } = renderApp();
    fireEvent.click(dock().getByRole("button", { name: "Hide tethers" }));
    expect(container.querySelector(".world svg.tethers")).toBeNull();
    expect(JSON.parse(localStorage.getItem(LOOK_STORAGE_KEY) ?? "{}").tethers).toBe(false);
    expect(dock().getByRole("button", { name: "Show tethers" })).toBeInTheDocument();
    fireEvent.click(dock().getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
});
