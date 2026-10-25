/**
 * Getting started › This computer: what the install found here and the setup still to apply,
 * from what volleyd already publishes. The card is titled with this computer's machine name and
 * lists the install checks: the broker from `setup_plan`'s detect step, the runtime, GitHub CLI,
 * terminal and Claude Code from the supervisor's own machine record (`kind: "supervisor"`, its
 * `versions`), and Volley services from the services step's plan. A missing tool shows ✕ and its
 * fix (`fixFor`, the machine cards' table). Under it, the security, accounts and services steps
 * as the setup wizard draws them (`PlanStep` over `useSetupPlan`: Apply sends the same
 * `setup_apply { step, plan_id }` and re-plans, the admin token is shown once, a broker restart
 * reconnects). "Name this computer" writes `fleet.local_name` through the config transport,
 * checked by `machineNameProblem` first.
 */
import { useEffect, useId, useState } from "react";
import { fixFor } from "../../settings/machineFixes";
import {
  type Applying,
  PlanStep,
  type SetupPlanState,
  useSetupPlan,
} from "../../settings/setupPlanParts";
import type { SetupPlan, SetupStepName, SetupStepPlan } from "../../store/control";
import type { MachinePayload } from "../../store/types";
import type { StepProps } from "../steps";
import { machineNameProblem } from "./machineName";

/** The setup steps this step applies; detect is the checklist's broker row, phone is Access's. */
const APPLIED: readonly SetupStepName[] = ["security", "accounts", "services"];
const IDLE: Applying = { state: "idle" };

type CheckState = "ok" | "missing" | "pending";

export interface InstallCheck {
  label: string;
  value: string;
  state: CheckState;
  /** What fixes a missing one. */
  fix?: string;
}

/**
 * The checklist's rows. `record` is the supervisor's machine record (absent until it arrives),
 * `plan` volleyd's setup plan (absent while it is asked for, or from a volleyd without setup ops),
 * `starting` whether the services step is being applied now.
 */
export function installChecks(
  record: MachinePayload | undefined,
  plan: SetupPlan | undefined,
  machine: string,
  starting: boolean,
): InstallCheck[] {
  const v = record?.versions;
  const step = (s: SetupStepName) => plan?.steps.find((p) => p.step === s);
  const tool = (label: string, name: string, shown: (ver: string) => string): InstallCheck => {
    if (!record) return { label, value: "checking…", state: "pending" };
    const ver = v?.[name];
    return ver
      ? { label, value: shown(ver), state: "ok" }
      : {
          label,
          value: "not found",
          state: "missing",
          fix: fixFor(`tool.${name}`, { machine }).text,
        };
  };

  const detect = step("detect");
  const mosquitto = detect?.found.find((f) => /^mosquitto /.test(f));
  const broker: InstallCheck = mosquitto
    ? { label: "Message broker", value: mosquitto.replace(/ \(from [^)]*\)$/, ""), state: "ok" }
    : detect
      ? {
          label: "Message broker",
          value: "not found",
          state: "missing",
          fix: detect.blocked ?? "install mosquitto 2.1 or later; `volley setup` installs it",
        }
      : { label: "Message broker", value: plan ? "not checked" : "checking…", state: "pending" };

  const cmux = plan?.steps.some((s) => s.found.some((f) => /\bcmux\b/.test(f))) === true;
  const terminal: InstallCheck = v?.tmux
    ? { label: "Terminal", value: `tmux ${v.tmux}`, state: "ok" }
    : cmux
      ? { label: "Terminal", value: "cmux", state: "ok" }
      : tool("Terminal", "tmux", (ver) => `tmux ${ver}`);

  const services = step("services");
  const volley: InstallCheck = starting
    ? { label: "Volley services", value: "starting…", state: "pending" }
    : services && services.changes.length === 0 && services.blocked === undefined
      ? { label: "Volley services", value: "done", state: "ok" }
      : { label: "Volley services", value: "pending", state: "pending" };

  return [
    broker,
    tool("Runtime", "bun", (ver) => `bun ${ver}`),
    tool("GitHub CLI", "gh", (ver) => `gh ${ver}`),
    terminal,
    tool("Claude Code", "claude", (ver) => ver),
    volley,
  ];
}

const GLYPH: Record<CheckState, string> = { ok: "✓", missing: "✕", pending: "…" };

export function ThisComputer({ ctx, setSummary }: StepProps) {
  const setup = useSetupPlan(ctx.ops);
  /** The step whose Apply was pressed: only it shows the apply's state. */
  const [active, setActive] = useState<SetupStepName | null>(null);
  const records = Object.values(ctx.state.machines ?? {});
  const record = records.find((m) => m.kind === "supervisor");
  const configured = ctx.state.config?.fleet?.local_name ?? record?.name ?? null;
  /** The name written here, until volleyd's config says so too. */
  const [named, setNamed] = useState<string | null>(null);
  const name = named ?? configured;

  useEffect(() => {
    if (name) setSummary({ machine: name });
  }, [name, setSummary]);

  const plan = setup.load.state === "ready" ? setup.load.plan : undefined;
  const starting = active === "services" && setup.applying.state === "busy";
  const rows = installChecks(record, plan, name ?? "this computer", starting);
  // The other machines' names: configured hosts and every paired record.
  const hosts = [
    ...Object.keys(ctx.state.config?.hosts ?? {}),
    ...records.filter((m) => m !== record).map((m) => m.name),
  ];

  return (
    <>
      <div className="gs-card gs-computer">
        <h3 className="gs-card-title">{name ?? "This computer"}</h3>
        <ul className="gs-checks" aria-label="Install checks">
          {rows.map((r) => (
            <li key={r.label} className={`gs-check gs-check--${r.state}`} data-state={r.state}>
              <span className="gs-check-glyph" aria-hidden="true">
                {GLYPH[r.state]}
              </span>
              <span className="gs-check-label">{r.label}</span>
              <span className="gs-check-value mono">{r.value}</span>
              {r.fix && <span className="gs-check-fix">{r.fix}</span>}
            </li>
          ))}
        </ul>
        <NameField
          key={configured ?? ""}
          name={name ?? ""}
          hosts={hosts}
          ctx={ctx}
          onNamed={setNamed}
        />
        <p className="gs-hint">
          Agents can also run here. You can turn that off later per machine.
        </p>
      </div>
      <SetupSteps setup={setup} active={active} onApply={setActive} />
    </>
  );
}

/** The pending setup steps, each as the setup wizard draws it. */
function SetupSteps({
  setup,
  active,
  onApply,
}: {
  setup: SetupPlanState;
  active: SetupStepName | null;
  onApply: (step: SetupStepName) => void;
}) {
  const { load } = setup;
  if (load.state === "loading") {
    return (
      <div className="gs-card waiting">
        <span className="spinner" aria-hidden /> Asking volleyd what setup would do…
      </div>
    );
  }
  if (load.state === "failed") {
    return (
      <div className="gs-card">
        <p className="s-error" role="alert">
          {load.error}. Check that volleyd is running (`volleyd status`), then try again.
        </p>
        <div className="wiz-actions wiz-actions--inline">
          <button
            type="button"
            className="btn btn--blue"
            onClick={() => {
              setup.setLoad({ state: "loading" });
              void setup.plan(setup.lan);
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (load.state === "unsupported") {
    return (
      <div className="gs-card">
        <p>
          This volleyd cannot run setup from the Desk yet. Run{" "}
          <code className="mono">volley setup</code> in a terminal on this computer: it shows each
          step and asks before changing anything.
        </p>
      </div>
    );
  }
  const steps = load.plan.steps;
  const order = steps.map((s) => s.step);
  const blockedBefore = (s: SetupStepPlan) =>
    steps.find((b) => b.blocked !== undefined && order.indexOf(b.step) < order.indexOf(s.step));
  return (
    <>
      {setup.reconnecting && (
        <output className="s-note wiz-reconnecting">
          <span className="spinner" aria-hidden /> The broker is restarting; reconnecting…
        </output>
      )}
      {steps
        .filter((s) => APPLIED.includes(s.step))
        .map((s) => {
          const before = blockedBefore(s);
          return (
            <section key={s.step} className="gs-card gs-plan" aria-label={s.title}>
              {before ? (
                <>
                  <h3>{s.title}</h3>
                  <p className="s-error" role="alert">
                    {before.title} is blocked, so this step cannot run yet: {before.blocked}
                  </p>
                </>
              ) : (
                <PlanStep
                  plan={s}
                  applying={active === s.step ? setup.applying : IDLE}
                  tokenShown={setup.tokenShown}
                  lan={setup.lan ?? s.lan?.planned ?? null}
                  replanning={setup.replanning}
                  onLan={(on) => void setup.pickLan(on)}
                  onApply={() => {
                    onApply(s.step);
                    void setup.apply(s);
                  }}
                  onRecheck={() => {
                    setup.setApplying(IDLE);
                    void setup.plan(setup.lan);
                  }}
                />
              )}
            </section>
          );
        })}
    </>
  );
}

type Saving = { k: "idle" } | { k: "busy" } | { k: "saved" } | { k: "problem"; text: string };

/** Name this computer: `fleet.local_name`, written on blur or Enter when it changed. */
function NameField({
  name,
  hosts,
  ctx,
  onNamed,
}: {
  name: string;
  hosts: readonly string[];
  ctx: StepProps["ctx"];
  onNamed: (name: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState<Saving>({ k: "idle" });

  const commit = async () => {
    const v = draft.trim();
    if (v === name || saving.k === "busy") return;
    const problem = machineNameProblem(v, hosts);
    if (problem !== null) return setSaving({ k: "problem", text: problem });
    if (!ctx.config) {
      return setSaving({
        k: "problem",
        text: `This Desk cannot write volleyd's config: run \`volleyd config set fleet.local_name ${v}\` on this computer`,
      });
    }
    setSaving({ k: "busy" });
    const ack = await ctx.config.send(
      { fleet: { local_name: v } },
      { text: `set fleet.local_name to ${v}` },
    );
    if (ack.applied) {
      onNamed(v);
      setSaving({ k: "saved" });
    } else {
      setSaving({
        k: "problem",
        text: `The name was not set: ${ack.rejected[0]?.reason ?? ack.error ?? "volleyd refused it"}`,
      });
    }
  };

  return (
    <div className="gs-name">
      <label htmlFor={`${id}-name`}>Name this computer</label>
      <input
        id={`${id}-name`}
        className="recessed mono"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        aria-invalid={saving.k === "problem"}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          setDraft(e.target.value);
          if (saving.k !== "busy") setSaving({ k: "idle" });
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          void commit();
        }}
      />
      <p id={`${id}-hint`} className="s-hint">
        The fleet's name for this machine. A new name takes effect at once: volleyd re-publishes
        this computer's record under the new name.
      </p>
      {saving.k === "problem" && (
        <p className="s-error" role="alert">
          {saving.text}
        </p>
      )}
      {saving.k === "busy" && <p className="s-hint">Saving…</p>}
      {saving.k === "saved" && <output className="s-hint">Saved.</output>}
    </div>
  );
}
