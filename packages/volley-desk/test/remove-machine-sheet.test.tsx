import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RemoveMachineSheet } from "../src/settings/RemoveMachineSheet";
import { fakePeerOps } from "./helpers/peer-ops";

function setup(agents = ["impl-1", "rev-2"], over: Parameters<typeof fakePeerOps>[0] = {}) {
  const ops = fakePeerOps(over);
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(
    <RemoveMachineSheet
      machine="box-a"
      agents={agents}
      ops={ops}
      onClose={onClose}
      onDone={onDone}
    />,
  );
  return { ops, onClose, onDone };
}

const sheet = () => within(screen.getByRole("dialog", { name: "Remove box-a" }));

describe("Remove machine sheet (peer_remove)", () => {
  it("lists the machine's running agents and what removing does", () => {
    setup();
    const running = within(sheet().getByRole("list", { name: "Running on box-a" }));
    expect(running.getByText("impl-1")).toBeInTheDocument();
    expect(running.getByText("rev-2")).toBeInTheDocument();
    const will = within(sheet().getByRole("list", { name: "This will" }));
    expect(will.getByText(/revoke box-a's broker account/)).toBeInTheDocument();
  });

  it("Drain, then remove sends drain: true and says what it waits for", async () => {
    const { ops, onDone } = setup(["impl-1", "rev-2"], {
      remove: vi.fn(async () => ({ ok: true, removing: "drain" as const, agents: 2 })),
    });
    await act(async () => {
      fireEvent.click(sheet().getByRole("button", { name: "Drain, then remove" }));
    });
    expect(ops.remove).toHaveBeenCalledWith("box-a", "drain");
    expect(onDone).toHaveBeenCalledWith(
      "box-a is draining: it is removed once its 2 agents finish.",
    );
  });

  it("Remove now asks to confirm, then sends now: true", async () => {
    const { ops, onDone } = setup();
    fireEvent.click(sheet().getByRole("button", { name: "Remove now" }));
    expect(ops.remove).not.toHaveBeenCalled();
    expect(sheet().getByText(/Stop 2 agents on box-a now\?/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(sheet().getByRole("button", { name: "Stop them and remove" }));
    });
    expect(ops.remove).toHaveBeenCalledWith("box-a", "now");
    expect(onDone).toHaveBeenCalled();
  });

  it("with nothing running it removes at once", async () => {
    const { ops, onDone } = setup([]);
    expect(sheet().getByText(/Nothing is running on box-a/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(sheet().getByRole("button", { name: "Remove box-a" }));
    });
    // drain still: volleyd, which has the real count, removes at once when nothing runs.
    expect(ops.remove).toHaveBeenCalledWith("box-a", "drain");
    expect(onDone).toHaveBeenCalled();
  });

  it("a refused removal says why", async () => {
    setup(["impl-1"], {
      remove: vi.fn(async () => ({ ok: false, error: '"box-a" is being removed already' })),
    });
    await act(async () => {
      fireEvent.click(sheet().getByRole("button", { name: "Drain, then remove" }));
    });
    expect(sheet().getByRole("alert")).toHaveTextContent('"box-a" is being removed already');
  });
});
