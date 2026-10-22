import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../src/App";
import { SignInGate } from "../src/auth/SignInGate";
import { LOOK_STORAGE_KEY } from "../src/look/useLook";
import { CREDENTIALS_STORAGE_KEY, DeskStoreProvider } from "../src/store/context";
import { connectingFactory } from "./helpers/desk-msgs";

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
  it("has exactly eight items, in order", () => {
    renderApp();
    expect(
      dock()
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual([
      "Wave coordinators",
      "Needs you",
      "Machines",
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

  it("the coordinators badge still shows what needs you, the inbox's beside it", () => {
    const { container } = renderApp();
    const pill = container.querySelector(".topbar .ny-pill")?.textContent ?? "";
    const n = Number(pill.match(/(\d+) needs? you/)?.[1]);
    const badge = (name: string) =>
      Number(dock().getByRole("button", { name }).textContent?.match(/\d+/)?.[0] ?? 0);
    expect(badge("Wave coordinators")).toBeGreaterThan(0);
    expect(badge("Needs you")).toBeGreaterThan(0);
    expect(badge("Wave coordinators") + badge("Needs you")).toBe(n);
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

describe("the dock's account menu (#328)", () => {
  const signedIn = (env: Record<string, unknown> = {}) =>
    render(
      <SignInGate
        demo={false}
        env={env}
        brokerUrl="ws://broker.test:9001"
        clientFactory={connectingFactory().make}
      >
        <App />
      </SignInGate>,
    );

  beforeEach(() => {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify({ username: "steer-0123abcd", password: "pw", role: "steer" }),
    );
  });

  it("a signed-in Desk has the account avatar last; its menu signs out", async () => {
    signedIn();
    const avatar = await screen.findByRole("button", { name: "Account" });
    expect(dock().getAllByRole("button").at(-1)).toBe(avatar);
    expect(avatar).toHaveTextContent("S0");
    fireEvent.click(avatar);
    const menu = within(screen.getByRole("dialog", { name: "Account" }));
    expect(menu.getByText("steer-0123abcd")).toBeInTheDocument();
    fireEvent.click(menu.getByRole("button", { name: "Sign out" }));
    expect(localStorage.getItem(CREDENTIALS_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole("form", { name: "Sign in to the broker" })).toBeInTheDocument();
  });

  it("Switch account… in the menu opens the token entry and closes the menu", async () => {
    signedIn();
    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Account" })).getByRole("button", {
        name: "Switch account…",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Account" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Switch account" })).toBeInTheDocument();
  });

  it("Escape closes the menu", async () => {
    signedIn();
    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Account" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Account" })).toBeNull();
  });

  it("closing the menu gives focus back to the avatar", async () => {
    signedIn();
    const avatar = await screen.findByRole("button", { name: "Account" });
    avatar.focus();
    fireEvent.click(avatar);
    const menu = screen.getByRole("dialog", { name: "Account" });
    expect(menu).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(avatar).toHaveFocus();
  });

  it("signed in by the environment, the menu says so and offers no sign-out", async () => {
    signedIn({ VITE_VOLLEY_BROKER_USERNAME: "desk", VITE_VOLLEY_BROKER_PASSWORD: "pw" });
    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    const menu = within(screen.getByRole("dialog", { name: "Account" }));
    expect(menu.getByText(/signed in by environment/i)).toBeInTheDocument();
    expect(menu.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
