// G1: after the admin sign-in the Desk opens Getting started (not Settings › Setup & Security)
// until this browser finishes or skips it; `#getting-started` opens it; a steer Desk never does.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { __resetArtMapForTests } from "../src/getting-started/art/assetMap";
import { PROGRESS_KEY, readProgress } from "../src/getting-started/state";
import { CREDENTIALS_STORAGE_KEY, DeskStoreProvider } from "../src/store/context";
import { markFirstRun } from "../src/store/control";
import { fakeClient } from "./helpers/desk-msgs";

const ADMIN = "admin-0123abcd";
const STEER = "steer-11112222";

function signedIn(username: string, role: string) {
  localStorage.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify({ username, password: "pw", role }));
}

function mount() {
  const f = fakeClient();
  const view = render(
    <DeskStoreProvider
      demo={false}
      brokerUrl="ws://test.invalid"
      clientFactory={() => f.client}
      settleMs={10}
    >
      <App />
    </DeskStoreProvider>,
  );
  act(() => f.up());
  return view;
}

const gettingStarted = () => screen.queryByRole("dialog", { name: "Getting started" });
const settings = () => screen.queryByRole("dialog", { name: "Settings" });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  __resetArtMapForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("Getting started on first launch", () => {
  it("opens on Welcome after an admin token sign-in, instead of Settings", () => {
    signedIn(ADMIN, "admin");
    markFirstRun();
    mount();
    const dialog = gettingStarted();
    expect(dialog).not.toBeNull();
    expect(within(dialog as HTMLElement).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Let's get your first wave in the air.",
    );
    expect(settings()).toBeNull();
  });

  it("a skipped Getting started leaves the first run with Settings › Setup & Security", () => {
    signedIn(ADMIN, "admin");
    localStorage.setItem(
      PROGRESS_KEY,
      JSON.stringify({ v: 1, step: "welcome", summary: {}, done: { kind: "skipped", at: "x" } }),
    );
    markFirstRun();
    mount();
    expect(gettingStarted()).toBeNull();
    const s = settings();
    expect(s).not.toBeNull();
    expect(within(s as HTMLElement).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Setup & Security",
    );
  });

  it("a finished one opens nothing", () => {
    signedIn(ADMIN, "admin");
    localStorage.setItem(
      PROGRESS_KEY,
      JSON.stringify({ v: 1, step: "done", summary: {}, done: { kind: "finished", at: "x" } }),
    );
    markFirstRun();
    mount();
    expect(gettingStarted()).toBeNull();
    expect(settings()).toBeNull();
  });

  it("an admin Desk with no marker opens it on load, and reopens where it was closed", () => {
    signedIn(ADMIN, "admin");
    const first = mount();
    fireEvent.click(screen.getByRole("button", { name: "Let's go" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Getting started" }));
    expect(gettingStarted()).toBeNull();
    expect(readProgress(localStorage).step).toBe("this-computer");
    first.unmount();
    mount();
    expect(screen.getByText("Step 1 of 6")).toBeInTheDocument();
  });

  it("Skip for now stops it reopening; Settings › Setup & Security › Open… reopens it", () => {
    signedIn(ADMIN, "admin");
    const first = mount();
    fireEvent.click(screen.getAllByRole("button", { name: "Skip for now" })[0] as HTMLElement);
    expect(gettingStarted()).toBeNull();
    expect(readProgress(localStorage).done?.kind).toBe("skipped");
    first.unmount();
    mount();
    expect(gettingStarted()).toBeNull();
    const dock = within(screen.getByRole("navigation", { name: "Desk controls" }));
    fireEvent.click(dock.getByRole("button", { name: "Settings" }));
    const s = settings() as HTMLElement;
    const sections = within(within(s).getByRole("navigation", { name: "Settings sections" }));
    fireEvent.click(sections.getByRole("button", { name: /Setup & Security/ }));
    expect(within(s).getByText(/^Skipped /)).toBeInTheDocument();
    fireEvent.click(within(s).getByRole("button", { name: "Open…" }));
    expect(gettingStarted()).not.toBeNull();
    expect(settings()).toBeNull();
  });

  it("#getting-started opens it for an admin, even when finished, and the fragment is dropped", () => {
    signedIn(ADMIN, "admin");
    localStorage.setItem(
      PROGRESS_KEY,
      JSON.stringify({ v: 1, step: "done", summary: {}, done: { kind: "finished", at: "x" } }),
    );
    window.history.replaceState(null, "", "/#getting-started");
    mount();
    expect(gettingStarted()).not.toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("a steer Desk never sees it, even with the hash, and Setup has no Getting started row", () => {
    signedIn(STEER, "steer");
    markFirstRun();
    window.history.replaceState(null, "", "/#getting-started");
    mount();
    expect(gettingStarted()).toBeNull();
    const s = settings();
    if (s) expect(within(s).queryByText("Getting started")).toBeNull();
  });
});
