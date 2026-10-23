import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Autopilot, POLICY_COLUMNS, PolicyTable } from "../src/settings/Autopilot";
import type { ConfigTransport } from "../src/settings/configTransport";
import { CONFIG_SCHEMA, schemaRows } from "../src/settings/schemaRows";
import { matchGroups, matchSections } from "../src/settings/sections";
import type { ControlReply } from "../src/steer/transport";
import type { ConfigPayload } from "../src/store/types";

const config: ConfigPayload = {
  version: 7,
  updated_at: "2026-10-20T12:00:00.000Z",
  updated_by: "owner",
  hard_ceiling: 6,
  autopilot: {
    enabled: true,
    owner_only: ["plan_change", "repo_untrusted", "model_switch", "release_go", "stage_go"],
    relaunch_max: 1,
    nudge_max: 1,
    respawn_max: 1,
    rereview_max: 2,
    ci_fixup_max: 2,
    question_max: 1,
    account_move_max: 2,
    budget_raise_max: 2,
    inbox_answered_ttl_s: 600,
    merge: "auto",
    merge_retry_max: 2,
    // merge_transient_backoff_s, a list of integers, has no row: it is set in config.yaml.
    merge_transient_retry_max: 1,
    delete_branch: false,
    reconnect_grace_s: 900,
    incident_wait_max_s: 14_400,
    fix_flake_max: 3,
    digest_min_interval_s: 1800,
    merge_train: true,
  },
};

const RULES = [
  {
    policy: "hooks_auth_failed/relaunch",
    kind: "hooks_auth_failed",
    condition: "a bad launch",
    answer: "relaunch",
    budget: "relaunch_max per <task>/<role>",
    max: 1,
    rationale: "a bad launch is cheaper to retry than to read",
  },
  {
    policy: "plan_change/owner",
    kind: "plan_change",
    condition: "always",
    answer: "(escalate)",
    budget: null,
    max: null,
    rationale: "the plan is the owner's",
  },
];

function fakes(
  policy: ControlReply = { ok: true, result: { config: config.autopilot, rules: RULES } },
) {
  const transport: ConfigTransport = {
    identity: "desk",
    send: vi.fn(async () => ({ applied: true, version: 8, rejected: [] })),
  };
  const control = vi.fn(async () => policy);
  return { transport, control };
}

const rowOf = (label: string) =>
  screen
    .getByText(label, { selector: ".cfg-lbl > span:first-child" })
    .closest(".cfg-row") as HTMLElement;

describe("Settings › Autopilot", () => {
  it("is a Settings section the sidebar search finds", () => {
    expect(matchSections("policy").map((s) => s.key)).toContain("autopilot");
    expect(matchSections("owner only").map((s) => s.key)).toContain("autopilot");
    expect(matchGroups("owner only")).toEqual([{ section: "autopilot", group: "tunables" }]);
    expect(matchGroups("rationale")).toEqual([{ section: "autopilot", group: "policy" }]);
  });

  it("renders a row for every autopilot.* tunable, with its bounds", () => {
    const { transport, control } = fakes();
    render(<Autopilot config={config} transport={transport} control={control} group="tunables" />);
    const keys = Object.keys(config.autopilot ?? {});
    const rows = schemaRows(CONFIG_SCHEMA, config).filter((r) => r.path.startsWith("autopilot."));
    expect(rows.map((r) => r.path.slice("autopilot.".length)).sort()).toEqual([...keys].sort());
    for (const r of rows) {
      const el = document.querySelector(`.cfg-row[data-path="${r.path}"]`);
      expect(el, r.path).not.toBeNull();
      if (r.control.kind === "slider") {
        const slider = within(el as HTMLElement).getByRole("slider");
        expect(slider).toHaveAttribute("aria-valuemin", String(r.control.min));
        expect(slider).toHaveAttribute("aria-valuemax", String(r.control.max));
      }
    }
    // Only autopilot's rows: the Supervisor section keeps the rest.
    expect(document.querySelector('.cfg-row[data-path="hard_ceiling"]')).toBeNull();
  });

  it("owner_only is a multi-select of the decision kinds", () => {
    const { transport, control } = fakes();
    render(<Autopilot config={config} transport={transport} control={control} group="tunables" />);
    const group = within(rowOf("Owner only")).getByRole("group", { name: "Owner only" });
    const boxes = within(group).getAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThanOrEqual(23);
    expect(within(group).getByRole("checkbox", { name: "release_go" })).toBeChecked();
    expect(within(group).getByRole("checkbox", { name: "ci_failed" })).not.toBeChecked();
    fireEvent.click(within(group).getByRole("checkbox", { name: "ci_failed" }));
    expect(transport.send).toHaveBeenCalledWith(
      {
        autopilot: {
          owner_only: [
            "plan_change",
            "repo_untrusted",
            "model_switch",
            "release_go",
            "stage_go",
            "ci_failed",
          ],
        },
      },
      expect.anything(),
    );
  });

  it("changing autopilot.enabled sends config_set in the global scope (no wave)", async () => {
    const { transport, control } = fakes();
    render(<Autopilot config={config} transport={transport} control={control} group="tunables" />);
    fireEvent.click(within(rowOf("Enabled")).getByRole("switch"));
    expect(transport.send).toHaveBeenCalledTimes(1);
    const [patch, opts] = (transport.send as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(patch).toEqual({ autopilot: { enabled: false } });
    expect(opts).not.toHaveProperty("wave");
    expect(await within(rowOf("Enabled")).findByText("applied · v8")).toBeInTheDocument();
  });

  it("in a wave's scope shows that wave's values read-only and asks for that wave's policy", async () => {
    const { transport, control } = fakes();
    render(
      <Autopilot
        config={config}
        transport={transport}
        control={control}
        wave="w1"
        group="tunables"
        values={{ autopilot: { ...config.autopilot, enabled: false } }}
      />,
    );
    const toggle = within(rowOf("Enabled")).getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toBeDisabled();
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith("policy", { wave: "w1" }, expect.any(String)),
    );
  });

  it("renders the policy op's rows as a read-only table", async () => {
    const { transport, control } = fakes();
    render(<Autopilot config={config} transport={transport} control={control} group="policy" />);
    const table = await screen.findByRole("table", { name: "Autopilot policy" });
    expect(control).toHaveBeenCalledWith("policy", {}, expect.any(String));
    const heads = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(heads).toEqual([...POLICY_COLUMNS]);
    expect(heads).toEqual(["kind", "condition", "answer", "budget", "rationale"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      rows.map((r) =>
        within(r)
          .getAllByRole("cell")
          .map((c) => c.textContent),
      ),
    ).toEqual([
      [
        "hooks_auth_failed",
        "a bad launch",
        "relaunch",
        "relaunch_max per <task>/<role> · max 1",
        "a bad launch is cheaper to retry than to read",
      ],
      ["plan_change", "always", "(escalate)", "—", "the plan is the owner's"],
    ]);
    expect(within(table).queryByRole("textbox")).toBeNull();
    expect(within(table).queryByRole("button")).toBeNull();
  });

  it("says why there is no table when the Desk cannot ask or volleyd refuses", async () => {
    const { transport } = fakes();
    const { unmount } = render(
      <Autopilot config={config} transport={transport} control={null} group="policy" />,
    );
    expect(screen.getByText(/volleyd policy/)).toBeInTheDocument();
    unmount();
    const { control } = fakes({ ok: false, error: "unknown op 'policy'" });
    render(<Autopilot config={config} transport={transport} control={control} group="policy" />);
    expect(await screen.findByText(/unknown op 'policy'/)).toBeInTheDocument();
  });
});

/** settings.css, whitespace collapsed. */
const settingsCss = readFileSync(join(__dirname, "../src/styles/settings.css"), "utf8").replace(
  /\s+/g,
  " ",
);

/** The body of the first rule whose selector list is exactly `selector`, in `css`. */
const ruleFor = (css: string, selector: string) => {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
};

/** The phone `@media (max-width: 699.98px)` block that holds the policy table's rules. */
function phonePolicyCss(): string {
  // Each block's body ends at its first `} }` (the last rule's brace, then the block's).
  const blocks = settingsCss
    .split("@media (max-width: 699.98px)")
    .slice(1)
    .map((b) => b.slice(0, b.indexOf("} }") + 1));
  const block = blocks.find((b) => b.includes(".policy-"));
  expect(block, "a phone block for the policy table").toBeDefined();
  return block as string;
}

const WIDE_RULES = [
  ...RULES,
  {
    policy: "ci_failed/fixup",
    kind: "ci_failed,ci_flaky,ci_timeout",
    condition: 'pipeline.on === "relaunch"',
    answer: "fixup",
    budget: "ci_fixup_max per <task>/<role>",
    max: 2,
    rationale: "a red check is usually the implementer's to fix",
  },
];

describe("Settings › Autopilot policy table fits the pane (#278)", () => {
  it("sits in a horizontally scrollable container, so a narrow pane scrolls rather than clips", () => {
    const { container } = render(<PolicyTable rules={WIDE_RULES} />);
    const scroll = container.querySelector(".policy-scroll");
    expect(scroll).not.toBeNull();
    expect(scroll?.querySelector("table.policy-table")).not.toBeNull();
    expect(ruleFor(settingsCss, ".policy-scroll")).toContain("overflow-x: auto");
  });

  it("wraps its cells in fixed columns that give rationale the most room; nothing is nowrap", () => {
    const { container } = render(<PolicyTable rules={WIDE_RULES} />);
    const table = ruleFor(settingsCss, ".policy-table");
    expect(table).toContain("table-layout: fixed");
    const cells = [...container.querySelectorAll("table.policy-table td")];
    expect(cells.length).toBe(WIDE_RULES.length * 5);
    for (const td of cells) expect(td.classList.contains("policy-wrap"), td.outerHTML).toBe(true);
    expect(ruleFor(settingsCss, ".policy-wrap")).toContain("overflow-wrap: anywhere");
    const policyRules = settingsCss.match(/\.policy-[^{]*\{[^}]*\}/g) ?? [];
    for (const r of policyRules) expect(r).not.toContain("nowrap");
    const cols = [...container.querySelectorAll("table.policy-table col")].map((c) =>
      Number.parseFloat((c as HTMLElement).style.width),
    );
    expect(cols).toHaveLength(5);
    expect(cols.reduce((a, b) => a + b, 0)).toBe(100);
    expect(Math.max(...cols)).toBe(cols[4]);
  });

  it("breaks a comma-joined kind list after its commas", () => {
    const { container } = render(<PolicyTable rules={WIDE_RULES} />);
    const kind = container.querySelector("tbody tr:last-child td") as HTMLElement;
    expect(kind.textContent).toBe("ci_failed,ci_flaky,ci_timeout");
    expect(kind.querySelectorAll("wbr")).toHaveLength(2);
  });

  it("at phone width renders one stacked block per rule with all five facts", () => {
    const { container } = render(<PolicyTable rules={WIDE_RULES} />);
    const blocks = [...container.querySelectorAll(".policy-stack > .policy-rule")];
    expect(blocks).toHaveLength(WIDE_RULES.length);
    const last = blocks[2] as HTMLElement;
    expect(last.querySelector(".policy-rule-kind")?.textContent).toBe(
      "ci_failed,ci_flaky,ci_timeout",
    );
    const facts = Object.fromEntries(
      [...last.querySelectorAll("dt")].map((dt) => [
        dt.textContent,
        dt.nextElementSibling?.textContent,
      ]),
    );
    expect(facts).toEqual({
      condition: 'pipeline.on === "relaunch"',
      answer: "fixup",
      budget: "ci_fixup_max per <task>/<role> · max 2",
      rationale: "a red check is usually the implementer's to fix",
    });
    // Wide: the table shows and the stack hides; phone: the other way round.
    expect(ruleFor(settingsCss, ".policy-stack")).toContain("display: none");
    const phone = phonePolicyCss();
    expect(ruleFor(phone, ".policy-scroll")).toContain("display: none");
    expect(ruleFor(phone, ".policy-stack")).toContain("display: block");
  });
});
