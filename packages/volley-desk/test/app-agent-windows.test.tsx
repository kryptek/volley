/**
 * The whole Desk in demo mode under a fake clock. It lives in its own file: rendering `App` with
 * its demo timers left the next test's `act` hanging when it shared a file with the AgentWindow
 * unit tests, and a test file is the isolation unit.
 */
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { DeskStoreProvider } from "../src/store/context";

describe("App agent windows", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an agent volleyd spawns mid-session pops in with the born class", () => {
    vi.useFakeTimers();
    const { container, unmount } = render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
    const born = () => [...container.querySelectorAll(".world .win--born .t-name")];
    expect(born()).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(22_500);
    });
    expect(born().map((n) => n.textContent)).toEqual(["T1 · Chip mapper + null-case handling"]);
    expect(container.querySelector(".world .win--born .chip--role")).toHaveTextContent(
      "spec review",
    );
    act(() => {
      vi.advanceTimersByTime(4_500);
    });
    expect(born()).toHaveLength(0);
    // Unmount under the fake clock, so the demo's timers are cleared before real timers return.
    unmount();
  });
});
