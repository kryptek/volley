import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../src/App";
import { DeskStoreProvider } from "../src/store/context";

describe("App (demo mode)", () => {
  it("renders a wave window per demo wave, a placeholder per agent, and the top-bar counts", () => {
    const { container } = render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
    expect(container.querySelectorAll(".world .win")).toHaveLength(3 + 5);
    const waveNames = [...container.querySelectorAll(".world .win .t-name")].map(
      (n) => n.textContent,
    );
    expect(waveNames).toEqual(["status-chip", "ci-speed", "leaderboard"]);
    expect(container.querySelectorAll(".world .dag")).toHaveLength(3);
    expect(screen.getByRole("region", { name: "status-chip-t1-fixup-1" })).toBeInTheDocument();
    expect(screen.getByText("Demo · sample data")).toBeInTheDocument();
    expect(container.querySelector(".topbar-mid")?.textContent).toContain("3 waves");
  });
});
