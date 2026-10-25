import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WizardContext } from "../src/getting-started/steps";
import { ThisComputer } from "../src/getting-started/steps/ThisComputer";
import { machineNameProblem } from "../src/getting-started/steps/machineName";
import type { ConfigAck, ConfigTransport } from "../src/settings/configTransport";
import type { AuthAnswer } from "../src/store/control";
import { initialState } from "../src/store/reducer";
import type { MachinePayload } from "../src/store/types";
import { PLAN, fakeOps } from "./helpers/auth-ops";
import { machineRecord } from "./helpers/desk-msgs";

const SUPERVISOR = machineRecord({
  name: "studio",
  kind: "supervisor",
  tunnel: "local",
  versions: {
    peer: "0.12.1",
    volley: "0.12.1",
    bun: "1.4",
    git: "2.47.0",
    gh: "2.62",
    claude: "2.1.310",
    tmux: "3.4",
  },
});
const PEER = machineRecord({ name: "box-a" });

/** PLAN once the security step is applied: nothing left to change there. */
const SECURED = {
  ...PLAN,
  steps: PLAN.steps.map((s) =>
    s.step === "security" ? { ...s, changes: [], plan_id: "security-2" } : s,
  ),
};

function fakeConfig(ack: ConfigAck = { applied: true, rejected: [] }) {
  const send = vi.fn(async (_patch: Record<string, unknown>, _opts?: { text?: string }) => ack);
  const config: ConfigTransport = { identity: "admin-0123abcd", send };
  return { config, send };
}

function mount({
  supervisor = SUPERVISOR,
  handlers = {
    setup_plan: () => ({ ok: true, result: PLAN }),
  },
  localName = "studio" as string | null,
  ack,
  noConfig = false,
}: {
  supervisor?: MachinePayload;
  handlers?: Record<string, (f: Record<string, unknown>) => AuthAnswer>;
  localName?: string | null;
  ack?: ConfigAck;
  noConfig?: boolean;
} = {}) {
  const { ops, calls } = fakeOps(handlers);
  const { config, send } = fakeConfig(ack);
  const ctx: WizardContext = {
    ops,
    control: null,
    state: {
      ...initialState(),
      machines: { [supervisor.name]: supervisor, "box-a": PEER },
      config: {
        version: 1,
        updated_at: "2026-10-18T12:00:00.000Z",
        updated_by: "volleyd",
        fleet: { local_name: localName },
        hosts: { "box-a": {} },
      },
    },
    deskUrl: "http://desk.example:5199/",
    identity: "admin-0123abcd",
    openSettings: vi.fn(),
    ...(noConfig ? {} : { config }),
  };
  const setSummary = vi.fn();
  render(
    <ThisComputer
      ctx={ctx}
      summary={{ machines: [], repos: [], people: [] }}
      setSummary={setSummary}
      onContinue={vi.fn()}
    />,
  );
  return { calls, send, setSummary };
}

const checks = () => within(screen.getByRole("list", { name: "Install checks" }));
const row = (label: string) => checks().getByText(label).closest("li") as HTMLElement;

describe("Getting started › This computer", () => {
  it("lists what the install found, with versions from the record and the broker from setup_plan", async () => {
    mount();
    expect(screen.getByRole("heading", { name: "studio" })).toBeInTheDocument();
    await waitFor(() => expect(row("Message broker")).toHaveTextContent("mosquitto 2.1.2"));
    expect(row("Message broker")).not.toHaveTextContent("from mosquitto -h");
    expect(row("Runtime")).toHaveTextContent("bun 1.4");
    expect(row("GitHub CLI")).toHaveTextContent("gh 2.62");
    expect(row("Terminal")).toHaveTextContent("tmux 3.4");
    expect(row("Claude Code")).toHaveTextContent("2.1.310");
    // PLAN's services step has nothing to change.
    expect(row("Volley services")).toHaveTextContent("done");
    expect(checks().getAllByRole("listitem")).toHaveLength(6);
    expect(
      screen.getByText(/Agents can also run here\. You can turn that off later per machine\./),
    ).toBeInTheDocument();
  });

  it("a missing tool shows ✕ and its fix, never a blank", async () => {
    mount({
      supervisor: { ...SUPERVISOR, versions: { ...SUPERVISOR.versions, gh: null } },
    });
    await waitFor(() => expect(row("Message broker")).toHaveTextContent("mosquitto"));
    const gh = row("GitHub CLI");
    expect(gh).toHaveAttribute("data-state", "missing");
    expect(gh).toHaveTextContent("✕");
    expect(gh).toHaveTextContent("install gh on studio");
  });

  it("Volley services reads pending while the services step has changes", async () => {
    const pending = {
      ...PLAN,
      steps: PLAN.steps.map((s) =>
        s.step === "services" ? { ...s, changes: [{ summary: "Install volleyd's service" }] } : s,
      ),
    };
    mount({ handlers: { setup_plan: () => ({ ok: true, result: pending }) } });
    await waitFor(() => expect(row("Volley services")).toHaveTextContent("pending"));
  });

  it("renders security, accounts and services as plans; Apply sends setup_apply and re-plans", async () => {
    let plan: typeof PLAN = PLAN;
    const { calls } = mount({
      handlers: {
        setup_plan: () => ({ ok: true, result: plan }),
        setup_apply: () => {
          plan = SECURED;
          return { ok: true, result: { step: "security", lines: ["Wrote it"], problems: [] } };
        },
      },
    });
    const security = within(await screen.findByRole("region", { name: "Security" }));
    expect(
      security.getByText(
        "Write Volley's Dynamic Security config (the old one is kept as a backup)",
      ),
    ).toBeInTheDocument();
    expect(
      security.getByText("Restart the broker (about 2 s; agents reconnect on their own)"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Services" })).getByText(
        /Already done: nothing to change\./,
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Accounts" })).getByRole("button", {
        name: "Apply this change",
      }),
    ).toBeInTheDocument();
    // Detect and phone are not this step's: the broker is in the checklist, the phone in Access.
    expect(screen.queryByRole("region", { name: "Phone" })).toBeNull();

    fireEvent.click(security.getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() =>
      expect(calls.find((c) => c.op === "setup_apply")?.fields).toMatchObject({
        step: "security",
        plan_id: "security-1",
      }),
    );
    await waitFor(() => expect(calls.filter((c) => c.op === "setup_plan")).toHaveLength(2));
    expect(await security.findByText(/Applied\./)).toBeInTheDocument();
    // Only the applied step shows its report; the others keep their Apply.
    expect(
      within(screen.getByRole("region", { name: "Accounts" })).getByRole("button", {
        name: "Apply this change",
      }),
    ).toBeInTheDocument();
  });

  it("shows the one-time admin token once", async () => {
    mount({
      handlers: {
        setup_plan: () => ({ ok: true, result: PLAN }),
        setup_apply: () => ({
          ok: true,
          result: { step: "accounts", lines: [], problems: [] },
          secret: { token: "vly_admin_89abcdef_0123456789abcdef0123456789abcdef" },
        }),
      },
    });
    const accounts = within(await screen.findByRole("region", { name: "Accounts" }));
    fireEvent.click(accounts.getByRole("button", { name: "Apply this change" }));
    expect(await accounts.findByText("One-time admin token (shown once)")).toBeInTheDocument();
  });

  it("a volleyd that cannot run setup says to run it in a terminal; the checklist stays", async () => {
    mount({ handlers: {} });
    expect(await screen.findByText(/volley setup/, { selector: "code" })).toBeInTheDocument();
    expect(row("Runtime")).toHaveTextContent("bun 1.4");
  });

  describe("Name this computer", () => {
    const input = () => screen.getByRole("textbox", { name: "Name this computer" });

    it("is prefilled with fleet.local_name and explains the record is re-published", () => {
      mount();
      expect(input()).toHaveValue("studio");
      expect(
        screen.getByText(/re-publishes this computer's record under the new name/),
      ).toBeInTheDocument();
    });

    it("falls back to the record's name when fleet.local_name is unset", () => {
      mount({ localName: null });
      expect(input()).toHaveValue("studio");
    });

    it("an invalid name shows the grammar and writes nothing", () => {
      const { send } = mount();
      fireEvent.change(input(), { target: { value: "box 1" } });
      fireEvent.blur(input());
      expect(screen.getByRole("alert")).toHaveTextContent(/lower-case letters, digits, - or _/);
      expect(send).not.toHaveBeenCalled();
    });

    it("a paired machine's name is refused", () => {
      const { send } = mount();
      fireEvent.change(input(), { target: { value: "box-a" } });
      fireEvent.keyDown(input(), { key: "Enter" });
      expect(screen.getByRole("alert")).toHaveTextContent("that is another machine's name");
      expect(send).not.toHaveBeenCalled();
    });

    it("a valid name is written through the config transport and the title follows", async () => {
      const { send, setSummary } = mount();
      fireEvent.change(input(), { target: { value: "desk-1" } });
      fireEvent.keyDown(input(), { key: "Enter" });
      await waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          { fleet: { local_name: "desk-1" } },
          expect.objectContaining({ text: expect.any(String) }),
        ),
      );
      expect(await screen.findByRole("heading", { name: "desk-1" })).toBeInTheDocument();
      expect(setSummary).toHaveBeenLastCalledWith({ machine: "desk-1" });
    });

    it("a name volleyd refuses shows its reason and the title stays", async () => {
      mount({
        ack: {
          applied: false,
          rejected: [{ path: "fleet.local_name", reason: "desk-1 is a configured host" }],
        },
      });
      fireEvent.change(input(), { target: { value: "desk-1" } });
      fireEvent.keyDown(input(), { key: "Enter" });
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The name was not set: desk-1 is a configured host",
      );
      expect(screen.getByRole("heading", { name: "studio" })).toBeInTheDocument();
    });

    it("no answer in time shows the transport's error", async () => {
      mount({
        ack: { applied: false, rejected: [], error: "volleyd did not answer within 10s" },
      });
      fireEvent.change(input(), { target: { value: "desk-1" } });
      fireEvent.blur(input());
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The name was not set: volleyd did not answer within 10s",
      );
    });

    it("without a config transport, says which volleyd command to run", () => {
      mount({ noConfig: true });
      fireEvent.change(input(), { target: { value: "desk-1" } });
      fireEvent.blur(input());
      expect(screen.getByRole("alert")).toHaveTextContent(
        "volleyd config set fleet.local_name desk-1",
      );
    });

    it("an unchanged name writes nothing", () => {
      const { send } = mount();
      fireEvent.blur(input());
      expect(send).not.toHaveBeenCalled();
    });
  });
});

describe("machineNameProblem", () => {
  it("takes the machine-name grammar", () => {
    expect(machineNameProblem("desk-1", [])).toBeNull();
    expect(machineNameProblem("a_b-9", [])).toBeNull();
    for (const bad of ["", "Box", "box 1", "-box", "_box", "x".repeat(64)])
      expect(machineNameProblem(bad, [])).toMatch(/lower-case letters, digits, - or _/);
    expect(machineNameProblem("x".repeat(63), [])).toBeNull();
  });

  it("refuses the reserved names and a configured host's", () => {
    for (const r of ["local", "auto", "volleyd", "desk", "coordinator"])
      expect(machineNameProblem(r, [])).toMatch(/reserved/);
    expect(machineNameProblem("box-a", ["box-a"])).toBe("that is another machine's name");
  });
});
