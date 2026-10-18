/**
 * Recessed text boxes (D10): every panel of text and every text field is sunk
 * into its window with the sign-in `f3d` recipe — one shared `recessed` class
 * (desk.css) — and a focused field shows a visible focus ring.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Appearance } from "../src/look/Appearance";
import { LOOK0 } from "../src/look/useLook";
import { SettingsModal } from "../src/settings/SettingsModal";
import { SteerPanel } from "../src/steer/SteerPanel";
import { demoMessages } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import type { ConfigPayload, Envelope, FeedEntry, WaveView } from "../src/store/types";
import { Feed } from "../src/windows/agent/Feed";
import { Terminal } from "../src/windows/agent/Terminal";
import { WaveYaml } from "../src/windows/wave/WaveYaml";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const noop = () => {};
const css = readFileSync(join(__dirname, "../src/styles/desk.css"), "utf8").replace(/\s+/g, " ");

function entry(): FeedEntry {
  const envelope: Envelope = {
    schema_version: "0.1",
    agent_id: "a1",
    wall_time: new Date(NOW).toISOString(),
    channel: "progress",
    type: "narration",
    payload: { msg: "Matrix written", progress: 38 },
  };
  return { topic: "volley/demo/a1/progress", envelope, receivedAt: NOW };
}

const demo = () => reduceAll(initialState(), demoMessages(NOW));

function demoWave(): WaveView {
  const state = demo();
  const wave = Object.values(state.waves).find((w) => w.state?.spec);
  if (!wave) throw new Error("no demo wave with a spec");
  return wave;
}

describe("recessed text boxes", () => {
  it("the Volley feed, empty or not, and the envelope JSON are recessed", () => {
    const { container, rerender } = render(<Feed feed={[]} />);
    expect(container.querySelector(".feed")).toHaveClass("recessed");
    rerender(<Feed feed={[entry()]} />);
    expect(container.querySelector(".feed")).toHaveClass("recessed");
    fireEvent.click(screen.getByRole("button", { name: /Matrix written/ }));
    expect(container.querySelector("pre.env-json")).toHaveClass("recessed");
  });

  it("the Terminal panel is recessed", () => {
    const { container } = render(<Terminal screen={null} stale={false} />);
    expect(container.querySelector(".term")).toHaveClass("recessed");
  });

  it("the wave-file YAML block is recessed", () => {
    const state = demoWave().state;
    if (!state) throw new Error("no state");
    render(<WaveYaml wave={state} />);
    expect(screen.getByLabelText("Wave file")).toHaveClass("recessed");
  });

  it("the steering input area is recessed, writable or read-only", () => {
    const { container, rerender } = render(
      <SteerPanel target="T2 · implementer" coordinator={false} onSend={noop} onClose={noop} />,
    );
    const field = container.querySelector(".steer-input");
    expect(field).toHaveClass("recessed");
    expect(field?.querySelector(".prompt-bar")).not.toBeNull();
    rerender(
      <SteerPanel
        target="T2 · implementer"
        coordinator={false}
        onSend={null}
        copy={{ wave: "w", task: "T2" }}
        onClose={noop}
      />,
    );
    expect(container.querySelector(".steer-ro-input")).toHaveClass("recessed");
  });

  it("settings text fields are recessed, and a focused one takes the focus ring", () => {
    const wave = demoWave();
    const config = demo().config as ConfigPayload;
    render(<SettingsModal wave={wave} config={config} transport={null} onClose={noop} />);
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    const field = screen.getByRole("textbox", { name: "Fallback model" });
    expect(field).toHaveClass("recessed");
    expect(field).toBeEnabled();
    field.focus();
    expect(document.activeElement).toBe(field);
    expect(document.activeElement?.matches(".recessed")).toBe(true);
  });

  it("the background search and the Appearance number field are recessed", () => {
    render(<Appearance look={LOOK0} setLook={noop} onClose={noop} onArrange={noop} />);
    expect(screen.getByRole("searchbox")).toHaveClass("recessed");
    expect(screen.getByRole("spinbutton")).toHaveClass("recessed");
  });

  it("the recipe: inset shadow, dark gradient fill, lit bottom edge, keyboard focus ring", () => {
    const at = css.indexOf(".recessed {");
    expect(at).toBeGreaterThanOrEqual(0);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toMatch(/inset 0 2px 5px rgba\(0, 0, 0, 0\.75\)/);
    expect(rule).toMatch(/linear-gradient\(180deg, rgba\(4, 5, 10/);
    expect(rule).toMatch(/0 1px 0 rgba\(255, 255, 255, 0\.08\)/);
    // A field shows the ring on focus; a panel (or the steer wrapper) when focus is inside it.
    expect(css).toMatch(/\.recessed:focus-visible[^{]*\{[^}]*0 0 0 3px/);
    expect(css).toMatch(/\.recessed:focus-within[^{]*\{[^}]*0 0 0 3px/);
  });
});
