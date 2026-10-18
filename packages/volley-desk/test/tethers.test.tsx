import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type Tether, Tethers, tetherPath } from "../src/look/Tethers";

const tethers: Tether[] = [
  { id: "a1", wave: { x: 0, y: 0, w: 620 }, agent: { x: 656, y: 0 }, accent: "#6ee7f9" },
  { id: "a2", wave: { x: 0, y: 0, w: 620 }, agent: { x: 656, y: 506 }, accent: "#6ee7f9" },
  { id: "b1", wave: { x: 0, y: 700, w: 620 }, agent: { x: 1152, y: 700 }, accent: "#c4b5fd" },
];

describe("Tethers", () => {
  it("draws one cubic per visible agent, wave edge → agent title bar, in the wave accent", () => {
    const { container } = render(<Tethers on tethers={tethers} />);
    const paths = [...container.querySelectorAll("svg.tethers path.tether")];
    expect(paths).toHaveLength(3);
    expect(paths.map((p) => p.getAttribute("stroke"))).toEqual(["#6ee7f9", "#6ee7f9", "#c4b5fd"]);
    expect(paths.map((p) => p.getAttribute("data-agent"))).toEqual(["a1", "a2", "b1"]);
    expect(paths[1]?.getAttribute("d")).toBe("M620,120 C638,120 638,532 656,532");
    expect(tetherPath(tethers[2] as Tether)).toBe("M620,820 C886,820 886,726 1152,726");
  });

  it("is hidden when off", () => {
    const { container } = render(<Tethers on={false} tethers={tethers} />);
    expect(container.querySelector("svg.tethers")).toBeNull();
  });
});
