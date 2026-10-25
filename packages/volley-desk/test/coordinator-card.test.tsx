import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CoordinatorCard, type CoordinatorCardProps } from "../src/settings/CoordinatorCard";
import type { ConfigTransport } from "../src/settings/configTransport";
import type { CoordinatorRolePayload, MachinePayload } from "../src/store/types";
import { fakeOps } from "./helpers/auth-ops";
import { NOW, machineRecord } from "./helpers/desk-msgs";

const LINK = "https://claude.ai/code/session_fake01";

const role = (over: Partial<CoordinatorRolePayload> = {}): CoordinatorRolePayload => ({
  machine: "box-a",
  name: "coord-test",
  state: "running",
  since: new Date(NOW).toISOString(),
  restarts: 0,
  session_url: LINK,
  ...over,
});

function transport() {
  const sent: Record<string, unknown>[] = [];
  const t: ConfigTransport = {
    identity: "desk-0123abcd",
    send: vi.fn(async (patch: Record<string, unknown>) => {
      sent.push(patch);
      return { applied: true, version: 2, rejected: [] };
    }),
  };
  return { t, sent };
}

const records = (): Record<string, MachinePayload> => ({
  "box-a": machineRecord({ name: "box-a" }),
  "box-b": machineRecord({ name: "box-b", laptop: true }),
});

function card(over: Partial<CoordinatorCardProps> = {}) {
  const { t, sent } = transport();
  const { ops, calls } = fakeOps({
    coordinator_restart: () => ({ ok: true, result: role({ state: "starting" }) }),
  });
  const props: CoordinatorCardProps = {
    coordinatorRole: role(),
    machines: records(),
    hosts: ["box-a", "box-b"],
    coordinator: { machine: "box-a", allow_laptop: false },
    transport: t,
    ops,
    ...over,
  };
  const view = render(<CoordinatorCard {...props} />);
  return { view, sent, calls };
}

const picker = () => screen.getByRole("combobox", { name: /coordinator machine/i });

describe("the Coordinator card", () => {
  it("lists this computer and every paired machine; picking one writes coordinator.machine", async () => {
    const { sent } = card({ coordinator: { machine: null }, coordinatorRole: null });
    const options = [...picker().querySelectorAll("option")].map((o) => o.value);
    expect(options).toEqual(["local", "box-a", "box-b"]);
    fireEvent.change(picker(), { target: { value: "box-a" } });
    await waitFor(() => expect(sent).toEqual([{ coordinator: { machine: "box-a" } }]));
  });

  it("greys a laptop with the reason until allow anyway is on", async () => {
    const { sent } = card();
    const laptop = picker().querySelector('option[value="box-b"]') as HTMLOptionElement;
    expect(laptop.disabled).toBe(true);
    expect(laptop.textContent).toMatch(/a laptop: sleeps and travels/);
    fireEvent.click(screen.getByRole("checkbox", { name: /allow anyway/i }));
    await waitFor(() => expect(sent).toEqual([{ coordinator: { allow_laptop: true } }]));
  });

  it("a laptop is pickable once allow_laptop is on", () => {
    card({ coordinator: { machine: "box-a", allow_laptop: true } });
    const laptop = picker().querySelector('option[value="box-b"]') as HTMLOptionElement;
    expect(laptop.disabled).toBe(false);
    expect(screen.getByRole("checkbox", { name: /allow anyway/i })).toBeChecked();
  });

  it("Off writes coordinator.machine: null; On writes the picked machine", async () => {
    const { sent } = card();
    const sw = screen.getByRole("switch", { name: /coordinator/i });
    expect(sw).toBeChecked();
    fireEvent.click(sw);
    await waitFor(() => expect(sent).toEqual([{ coordinator: { machine: null } }]));
  });

  it("On, from off, writes the machine shown in the picker", async () => {
    const { sent } = card({ coordinator: { machine: null }, coordinatorRole: null });
    fireEvent.click(screen.getByRole("switch", { name: /coordinator/i }));
    await waitFor(() => expect(sent).toEqual([{ coordinator: { machine: "local" } }]));
  });

  it("Restart sends coordinator_restart on the admin channel", async () => {
    const { calls } = card();
    fireEvent.click(screen.getByRole("button", { name: /restart/i }));
    await waitFor(() => expect(calls.map((c) => c.op)).toEqual(["coordinator_restart"]));
  });

  it("Open is the role's link", () => {
    card();
    const a = screen.getByRole("link", { name: /^open$/i });
    expect(a).toHaveAttribute("href", LINK);
    expect(a).toHaveAttribute("target", "_blank");
  });

  it("the state line follows the payload", () => {
    const { view } = card();
    expect(screen.getByTestId("coord-state")).toHaveTextContent(/running on box-a since/);
    view.rerender(
      <CoordinatorCard
        coordinatorRole={role({ state: "restarting", restarts: 2 })}
        machines={records()}
        hosts={["box-a", "box-b"]}
        coordinator={{ machine: "box-a" }}
        transport={null}
        ops={null}
      />,
    );
    expect(screen.getByTestId("coord-state")).toHaveTextContent("restarting (2)");
    view.rerender(
      <CoordinatorCard
        coordinatorRole={role({ state: "failed", last_error: "claude exited 1" })}
        machines={records()}
        hosts={["box-a", "box-b"]}
        coordinator={{ machine: "box-a" }}
        transport={null}
        ops={null}
      />,
    );
    expect(screen.getByTestId("coord-state")).toHaveTextContent("failed: claude exited 1");
    // Read-only without a transport and ops: no writes offered.
    expect(picker()).toBeDisabled();
    expect(screen.queryByRole("button", { name: /restart/i })).toBeNull();
  });

  it("renders standalone (the Getting started Access step) and tells onMachine", async () => {
    const onMachine = vi.fn();
    const { t } = transport();
    render(
      <CoordinatorCard
        coordinatorRole={null}
        machines={{ "box-a": machineRecord({ name: "box-a" }) }}
        hosts={["box-a"]}
        coordinator={{ machine: null }}
        transport={t}
        ops={null}
        onMachine={onMachine}
      />,
    );
    expect(screen.getByTestId("coord-state")).toHaveTextContent("off");
    fireEvent.change(picker(), { target: { value: "box-a" } });
    await waitFor(() => expect(onMachine).toHaveBeenCalledWith("box-a"));
  });
});
