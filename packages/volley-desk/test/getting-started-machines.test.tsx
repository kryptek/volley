import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WizardContext } from "../src/getting-started/steps";
import { Machines } from "../src/getting-started/steps/Machines";
import type { MachineAddRequest, PeerOps } from "../src/store/peerOps";
import { initialState } from "../src/store/reducer";
import type { MachineAddRow, MachinePayload } from "../src/store/types";
import { fakeOps } from "./helpers/auth-ops";
import { NOW, machineRecord } from "./helpers/desk-msgs";
import { fakePeerOps } from "./helpers/peer-ops";

const SUPERVISOR = machineRecord({ name: "studio", kind: "supervisor", tunnel: "local" });
const BOX_A = machineRecord({ name: "box-a", os: "linux", cores: 16, tunnel: "up" });
const DESK_1 = machineRecord({ name: "desk-1", os: "darwin", cores: 10, tunnel: "down" });

function mount(peerOps: Partial<PeerOps> = {}) {
  const peer = fakePeerOps(peerOps);
  const ctxWith = (extra: Record<string, MachinePayload> = {}): WizardContext => ({
    ops: fakeOps({}).ops,
    control: null,
    state: {
      ...initialState(),
      machines: { studio: SUPERVISOR, "box-a": BOX_A, "desk-1": DESK_1, ...extra },
      config: {
        version: 1,
        updated_at: new Date(NOW).toISOString(),
        updated_by: "volleyd",
        fleet: { local_name: "studio" },
        hosts: {
          "box-a": {},
          "desk-1": {},
          ...Object.fromEntries(Object.keys(extra).map((n) => [n, {}])),
        },
      },
    },
    deskUrl: "http://desk.example:5199/",
    identity: "admin-0123abcd",
    openSettings: vi.fn(),
    peerOps: peer,
    now: NOW,
  });
  const setSummary = vi.fn();
  const step = (ctx: WizardContext) => (
    <Machines
      ctx={ctx}
      summary={{ machines: [], repos: [], people: [] }}
      setSummary={setSummary}
      onContinue={vi.fn()}
    />
  );
  const { rerender } = render(step(ctxWith()));
  /** Re-render with more machine records, each a configured host. */
  const withMachines = (extra: Record<string, MachinePayload>) => rerender(step(ctxWith(extra)));
  return { peer, setSummary, withMachines };
}

const radio = (name: RegExp) => screen.getByRole("radio", { name });

describe("Getting started › Your machines", () => {
  it("lists the paired machines as cards (name · OS · cores · tunnel), never this computer", () => {
    mount();
    const list = within(screen.getByRole("list", { name: "Computers you've paired" }));
    const a = list.getByRole("article", { name: "box-a" });
    expect(a).toHaveTextContent("box-a");
    expect(a).toHaveTextContent("linux");
    expect(a).toHaveTextContent("16 cores");
    expect(a).toHaveTextContent("tunnel up");
    const d = list.getByRole("article", { name: "desk-1" });
    expect(d).toHaveTextContent("darwin");
    expect(d).toHaveTextContent("10 cores");
    expect(d).toHaveTextContent("tunnel down");
    expect(list.queryByRole("article", { name: "studio" })).toBeNull();
    expect(screen.getByRole("button", { name: "+ Another computer" })).toBeInTheDocument();
  });

  it("writes the computers to the summary", () => {
    const { setSummary } = mount();
    expect(setSummary).toHaveBeenCalledWith({ machines: ["studio", "box-a", "desk-1"] });
  });

  it("asks how this computer connects, Pairing code checked and recommended", () => {
    mount();
    const group = screen.getByRole("radiogroup", {
      name: "How will this computer connect to them?",
    });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(radio(/^Pairing code/)).toBeChecked();
    expect(radio(/^Pairing code/).closest("label")).toHaveTextContent("Recommended");
    expect(radio(/^SSH key/)).not.toBeChecked();
    expect(radio(/^Username and password/)).not.toBeChecked();
    expect(
      screen.getByText(
        "Run one line on the other computer, type the code shown here. Volley sets up the rest.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Use an SSH key you already have for that computer."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Sign in once; Volley swaps it for a key and forgets the password."),
    ).toBeInTheDocument();
  });

  it("Pairing code › Add it creates a code and shows the join line with --to", async () => {
    const { peer, setSummary } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Add it" }));
    await waitFor(() => expect(peer.invite).toHaveBeenCalledTimes(1));
    fireEvent.change(await screen.findByLabelText("This machine's ssh address"), {
      target: { value: "me@studio.lan" },
    });
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "CODE" &&
          el.textContent === "volley peer join MXQ4-7KDP --to me@studio.lan",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the machine to join/)).toBeInTheDocument();
    expect(screen.getByText(/10 minutes/)).toBeInTheDocument();
    expect(setSummary).not.toHaveBeenCalledWith(expect.objectContaining({ connectedBy: "code" }));
  });

  it("a machine that joins with the code writes connectedBy: code to the summary", async () => {
    const { peer, setSummary, withMachines } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Add it" }));
    await waitFor(() => expect(peer.invite).toHaveBeenCalledTimes(1));
    await screen.findByText(/Waiting for the machine to join/);
    withMachines({ "box-b": machineRecord({ name: "box-b" }) });
    await waitFor(() => expect(setSummary).toHaveBeenCalledWith({ connectedBy: "code" }));
  });

  it("+ Another computer opens the chosen way too", async () => {
    const { peer } = mount();
    fireEvent.click(screen.getByRole("button", { name: "+ Another computer" }));
    await waitFor(() => expect(peer.invite).toHaveBeenCalledTimes(1));
  });

  it("Username and password opens the add-a-machine form with Password chosen and its help", () => {
    mount();
    fireEvent.click(radio(/^Username and password/));
    fireEvent.click(screen.getByRole("button", { name: "Add it" }));
    const form = within(screen.getByRole("region", { name: "Add a bare machine" }));
    expect(form.getByRole("radio", { name: "Password" })).toBeChecked();
    expect(
      form.getByLabelText("Password", { selector: "input[type=password]" }),
    ).toHaveAccessibleDescription(/Volley swaps it for a key and forgets the password/);
  });

  it("SSH key opens it with Key file chosen", () => {
    mount();
    fireEvent.click(radio(/^SSH key/));
    fireEvent.click(screen.getByRole("button", { name: "Add it" }));
    const form = within(screen.getByRole("region", { name: "Add a bare machine" }));
    expect(form.getByRole("radio", { name: "Key file" })).toBeChecked();
    expect(form.getByLabelText("Key file path")).toBeInTheDocument();
  });

  it("a machine added by password writes connectedBy: password to the summary", async () => {
    const machineAdd = vi.fn(async (req: MachineAddRequest, onRow: (r: MachineAddRow) => void) => {
      onRow({
        step: 1,
        total: 7,
        title: "ssh",
        state: "running",
        line: "signed in with the password",
      });
      onRow({ step: 7, total: 7, title: "Doctor", state: "running", line: "ready" });
      return {
        ok: true as const,
        name: "box-b",
        target: req.address,
        ready: true,
        signin: { gh: true, claude: true },
        checks: [],
      };
    });
    const { setSummary } = mount({ machineAdd });
    fireEvent.click(radio(/^Username and password/));
    fireEvent.click(screen.getByRole("button", { name: "Add it" }));
    const form = within(screen.getByRole("region", { name: "Add a bare machine" }));
    fireEvent.change(form.getByLabelText("Address"), { target: { value: "dev@box-b.lan" } });
    fireEvent.change(form.getByLabelText("Password", { selector: "input[type=password]" }), {
      target: { value: "hunter2" },
    });
    fireEvent.click(form.getByRole("button", { name: "Add dev@box-b.lan" }));
    expect(await screen.findByText("box-b is ready for agents")).toBeInTheDocument();
    expect(machineAdd).toHaveBeenCalledWith(
      expect.objectContaining({ address: "dev@box-b.lan", password: "hunter2" }),
      expect.any(Function),
    );
    expect(setSummary).toHaveBeenCalledWith({ connectedBy: "password" });
  });
});
