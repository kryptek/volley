import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { About } from "../src/settings/About";

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});

describe("Settings › About Volley", () => {
  it("names volley bug, and its copy button copies exactly the command", async () => {
    render(<About />);
    expect(screen.getByText(/Something wrong\? Run/).textContent).toContain(
      "in a terminal: it gathers and redacts the diagnostics and opens an issue",
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy: volley bug" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("volley bug"));
  });
});
