import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WizardContext } from "../src/getting-started/steps";
import { Access } from "../src/getting-started/steps/Access";
import type { ConfigTransport } from "../src/settings/configTransport";
import type { AuthAnswer } from "../src/store/control";
import { initialState } from "../src/store/reducer";
import { PLAN, fakeOps } from "./helpers/auth-ops";
import { machineRecord } from "./helpers/desk-msgs";

/** The network step as P1a plans it: Tailscale by default, not yet installed. */
const NETWORK = {
  step: "network",
  title: "Network",
  found: ["Tailscale is not installed"],
  changes: [{ summary: "Install Tailscale and sign this machine in" }],
  plan_id: "network-1",
  network: { planned: "tailscale", current: null },
};
const withNetwork = (step: Record<string, unknown>) => ({
  ...PLAN,
  steps: [...PLAN.steps, step],
});

function fakeConfig() {
  const sent: Record<string, unknown>[] = [];
  const config: ConfigTransport = {
    identity: "admin-0123abcd",
    send: vi.fn(async (patch: Record<string, unknown>) => {
      sent.push(patch);
      return { applied: true, version: 2, rejected: [] };
    }),
  };
  return { config, sent };
}

function mount(
  handlers: Record<string, (f: Record<string, unknown>) => AuthAnswer> = {
    setup_plan: () => ({ ok: true, result: withNetwork(NETWORK) }),
  },
) {
  const { ops, calls } = fakeOps(handlers);
  const { config, sent } = fakeConfig();
  const ctx: WizardContext = {
    ops,
    control: null,
    state: {
      ...initialState(),
      machines: {
        studio: machineRecord({ name: "studio", kind: "supervisor", tunnel: "local" }),
        "box-a": machineRecord({ name: "box-a" }),
      },
      config: {
        version: 1,
        updated_at: "2026-10-18T12:00:00.000Z",
        updated_by: "volleyd",
        fleet: { local_name: "studio" },
        hosts: { "box-a": {} },
        coordinator: { machine: null, allow_laptop: false },
      },
      coordinatorRole: null,
    },
    deskUrl: "http://desk.example:5199/",
    identity: "admin-0123abcd",
    openSettings: vi.fn(),
    config,
  };
  const setSummary = vi.fn();
  render(
    <Access
      ctx={ctx}
      summary={{ machine: "studio", machines: ["studio"], repos: [], people: [] }}
      setSummary={setSummary}
      onContinue={vi.fn()}
    />,
  );
  return { calls, sent, setSummary };
}

const radio = (name: RegExp) => screen.getByRole("radio", { name });

describe("Getting started › Access", () => {
  it("offers the three ways in, Tailscale recommended and preselected from the plan", async () => {
    mount();
    const group = await screen.findByRole("radiogroup", {
      name: /how do you plan on reaching your cluster/i,
    });
    const choices = within(group).getAllByRole("radio");
    expect(choices).toHaveLength(3);
    expect(radio(/tailscale/i)).toBeChecked();
    expect(within(group).getByText(/recommended/i)).toBeInTheDocument();
    // No coordinator picked yet: the VPN is to this computer's network.
    expect(radio(/i'll vpn in to the network studio is on/i)).not.toBeChecked();
    expect(radio(/this network only/i)).not.toBeChecked();
  });

  it("shows the network step's found lines and changes", async () => {
    mount();
    expect(await screen.findByText("Tailscale is not installed")).toBeInTheDocument();
    expect(screen.getByText("Install Tailscale and sign this machine in")).toBeInTheDocument();
  });

  it("picking the VPN re-plans with network: manual and shows the address field", async () => {
    const { calls } = mount({
      setup_plan: (f) =>
        f.network === "manual"
          ? {
              ok: true,
              result: withNetwork({
                ...NETWORK,
                found: [],
                changes: [],
                plan_id: "network-2",
                blocked:
                  "network_address must be one of this machine's addresses: 192.168.1.20, 100.64.0.7",
                network: { planned: "manual", current: null },
              }),
            }
          : { ok: true, result: withNetwork(NETWORK) },
    });
    fireEvent.click(await screen.findByRole("radio", { name: /vpn in/i }));
    await waitFor(() =>
      expect(calls.filter((c) => c.op === "setup_plan").at(-1)?.fields).toEqual({
        network: "manual",
      }),
    );
    const address = screen.getByRole("textbox", { name: /address on your vpn/i });
    expect(
      await screen.findByText(/must be one of this machine's addresses: 192\.168\.1\.20/),
    ).toBeInTheDocument();
    fireEvent.change(address, { target: { value: "100.64.0.7" } });
    fireEvent.blur(address);
    await waitFor(() =>
      expect(calls.filter((c) => c.op === "setup_plan").at(-1)?.fields).toEqual({
        network: "manual",
        network_address: "100.64.0.7",
      }),
    );
  });

  it("Apply sends setup_apply for the network step and the sign-in line renders as a link and a QR", async () => {
    const { calls, setSummary } = mount({
      setup_plan: () => ({ ok: true, result: withNetwork(NETWORK) }),
      setup_apply: () => ({
        ok: true,
        result: {
          step: "network",
          lines: ["Installed Tailscale", "Sign in to Tailscale: https://login.example/a/abc"],
          problems: [],
        },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /apply/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.op === "setup_apply")?.fields).toEqual({
        step: "network",
        plan_id: "network-1",
        network: "tailscale",
      }),
    );
    const link = await screen.findByRole("link", { name: "https://login.example/a/abc" });
    expect(link).toHaveAttribute("href", "https://login.example/a/abc");
    expect(screen.getByRole("img", { name: /qr code.*sign in to tailscale/i })).toBeInTheDocument();
    expect(screen.getByText("Installed Tailscale")).toBeInTheDocument();
    expect(setSummary).toHaveBeenCalledWith({ network: "tailscale" });
  });

  it("a change only a terminal can make renders with its command", async () => {
    mount({
      setup_plan: () => ({
        ok: true,
        result: withNetwork({
          ...NETWORK,
          changes: [
            {
              summary: "Install Tailscale (needs sudo)",
              terminal: {
                reason: "it needs sudo",
                command: "curl -fsSL https://tailscale.com/install.sh | sh",
              },
            },
          ],
        }),
      }),
    });
    expect(await screen.findByText(/only a terminal can make this change/i)).toBeInTheDocument();
    expect(
      screen.getByText("curl -fsSL https://tailscale.com/install.sh | sh"),
    ).toBeInTheDocument();
  });

  it("embeds the Coordinator card; picking a machine writes coordinator.machine and the summary", async () => {
    const { sent, setSummary } = mount();
    expect(screen.getByText(/keep a claude coordinator session running on/i)).toBeInTheDocument();
    const card = screen.getByRole("article", { name: "Coordinator" });
    fireEvent.change(within(card).getByRole("combobox", { name: /coordinator machine/i }), {
      target: { value: "box-a" },
    });
    await waitFor(() => expect(setSummary).toHaveBeenCalledWith({ coordinatorMachine: "box-a" }));
    expect(sent).toEqual([{ coordinator: { machine: "box-a" } }]);
    // The VPN choice names the coordinator's machine now.
    expect(await screen.findByRole("radio", { name: /network box-a is on/i })).toBeInTheDocument();
  });

  it("a volleyd without a network step points at the terminal", async () => {
    mount({ setup_plan: () => ({ ok: true, result: PLAN }) });
    expect(await screen.findByText(/volley setup --network/)).toBeInTheDocument();
  });
});
