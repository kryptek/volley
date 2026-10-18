import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../src/App";
import { DeskStoreProvider } from "../src/store/context";

describe("App (demo mode)", () => {
  it("renders a window per demo wave and agent, and the top-bar counts", () => {
    const { container } = render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
    expect(container.querySelectorAll(".world .win")).toHaveLength(3 + 5);
    expect(screen.getByRole("region", { name: "status-chip" })).toBeInTheDocument();
    expect(container.querySelectorAll(".world .narr")).toHaveLength(5);
    expect(screen.getByText("Demo · sample data")).toBeInTheDocument();
    expect(container.querySelector(".topbar-mid")?.textContent).toContain("3 waves");
  });
});
