/**
 * The Settings window's sections, ported from the prototype `settings.tsx`
 * (`SECTIONS`): the sidebar label, the coloured icon tile, the sidebar group
 * and the extra words the sidebar search matches. A long section also lists the
 * groups it drills into (`GroupDef`), each with its own words and the config rows
 * on its page, so a search hit inside a group opens that group (`groupOf`).
 */
import {
  AiBrain01Icon,
  ComputerIcon,
  DashboardSpeed01Icon,
  GithubIcon,
  InformationCircleIcon,
  Key01Icon,
  PaintBoardIcon,
  Rocket01Icon,
  ServerStack01Icon,
  Settings02Icon,
  VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { CONFIG_SCHEMA, type Section, schemaRows } from "./schemaRows";

export type SectionKey =
  | "general"
  | "sound"
  | "appearance"
  | "supervisor"
  | "autopilot"
  | "claude"
  | "accounts"
  | "machines"
  | "repos"
  | "setup"
  | "about";

/**
 * A group of a long section (Supervisor, Autopilot, Sound, Claude accounts): a
 * row of the section's group list that opens the group's own page.
 */
export interface GroupDef {
  key: string;
  label: string;
  /** The words the sidebar search matches, besides the label (and `rows`' labels). */
  keywords: string;
  /** The config rows (`schemaRows` section) on the page: their labels are searched too. */
  rows?: Section;
}

export interface SectionDef {
  key: SectionKey;
  label: string;
  icon: typeof Settings02Icon;
  tint: string;
  /** The sidebar group (0–2), drawn as separate lists. */
  group: 0 | 1 | 2;
  keywords: string;
  /** The groups it drills into, like macOS System Settings; a section without stays one page. */
  groups?: readonly GroupDef[];
  /** Listed, but its content comes with Onboarding. */
  placeholder?: true;
}

export const SETTINGS_SECTIONS: readonly SectionDef[] = [
  {
    key: "general",
    label: "General",
    icon: Settings02Icon,
    tint: "#8e8e93",
    group: 0,
    keywords: "auto arrange notifications finished narration",
  },
  {
    key: "sound",
    label: "Sound",
    icon: VolumeHighIcon,
    tint: "#ff2d55",
    group: 0,
    keywords: "sound",
    groups: [
      { key: "theme", label: "Theme", keywords: "theme audition chime" },
      { key: "volume", label: "Volume", keywords: "master volume mute all" },
      {
        key: "events",
        label: "Sounds",
        keywords: "events ui agents pipeline wave steering system attention play",
      },
      {
        key: "when",
        label: "When sounds play",
        keywords: "only when hidden tab quiet hours attention reduced motion vibrate",
      },
    ],
  },
  {
    key: "appearance",
    label: "Appearance",
    icon: PaintBoardIcon,
    tint: "#5e5ce6",
    group: 0,
    keywords: "background dim window style needs you effect theme tethers",
  },
  {
    key: "supervisor",
    label: "Supervisor",
    icon: ServerStack01Icon,
    tint: "#30b0c7",
    group: 1,
    keywords: "supervisor volleyd config",
    groups: [
      {
        key: "leases",
        label: "Lease pools",
        keywords: "leases lease pools per machine holders queue capacity",
        rows: "Leases",
      },
      {
        key: "admission",
        label: "Admission",
        keywords: "ceiling spawn budget admission memory fleet local agents",
        rows: "Admission",
      },
      {
        key: "attention",
        label: "Attention",
        keywords: "escalate heartbeat claim mailbox",
        rows: "Attention",
      },
      {
        key: "recovery",
        label: "Recovery",
        keywords: "fallback model spawn timeout wake grace worktree",
        rows: "Recovery",
      },
      { key: "other", label: "Other", keywords: "", rows: "Other" },
    ],
  },
  {
    key: "autopilot",
    label: "Autopilot",
    icon: AiBrain01Icon,
    tint: "#bf5af2",
    group: 1,
    keywords: "autopilot",
    groups: [
      {
        key: "tunables",
        label: "Tunables",
        keywords:
          "owner only budgets relaunch nudge respawn rereview ci fixup merge queue reconnect grace",
        rows: "Autopilot",
      },
      {
        key: "policy",
        label: "Policy table",
        keywords: "policy rules kind condition answer budget rationale",
      },
    ],
  },
  {
    key: "claude",
    label: "Claude accounts & usage",
    icon: DashboardSpeed01Icon,
    tint: "#d97757",
    group: 1,
    keywords: "claude",
    groups: [
      {
        key: "accounts",
        label: "Accounts",
        keywords: "usage limit 5h weekly plan max 20x switch account tokens add sign in move",
      },
      {
        key: "defaults",
        label: "Defaults",
        keywords: "default account for new waves most headroom warn me at threshold",
      },
    ],
  },
  {
    key: "accounts",
    label: "Broker accounts",
    icon: Key01Icon,
    tint: "#ff9f0a",
    group: 1,
    keywords: "password login desk coordinator viewer rotate revoke admin",
  },
  {
    key: "machines",
    label: "Machines",
    icon: ComputerIcon,
    tint: "#34c759",
    group: 1,
    keywords:
      "peer pair add machine tunnel host fleet ready readiness doctor repair re-pair drain remove max agents cap",
  },
  {
    key: "repos",
    label: "Repositories",
    icon: GithubIcon,
    tint: "#6e7681",
    group: 1,
    keywords: "repository github clone owner/name toolchain trust",
  },
  {
    key: "setup",
    label: "Setup & Security",
    icon: Rocket01Icon,
    tint: "#ff453a",
    group: 2,
    keywords: "setup wizard broker token security admin phone qr sign-in link",
  },
  {
    key: "about",
    label: "About Volley",
    icon: InformationCircleIcon,
    tint: "#64748b",
    group: 2,
    keywords: "version license licence credits react bits",
  },
];

export const SECTION_GROUPS = [0, 1, 2] as const;

/** The config row labels per `schemaRows` section (no values: no per-pool rows). */
const ROW_LABELS = new Map<Section, string>();
for (const r of schemaRows(CONFIG_SCHEMA, null)) {
  ROW_LABELS.set(r.section, `${ROW_LABELS.get(r.section) ?? ""} ${r.label}`);
}

const needleOf = (q: string) => q.trim().toLowerCase();
const has = (words: string, needle: string) => words.toLowerCase().includes(needle);
const groupWords = (g: GroupDef) =>
  `${g.label} ${g.keywords}${g.rows ? (ROW_LABELS.get(g.rows) ?? "") : ""}`;

/**
 * The sections whose label or keywords, or any of whose groups' words, contain `q`
 * (case-insensitive); all of them for "".
 */
export function matchSections(q: string): SectionDef[] {
  const needle = needleOf(q);
  return SETTINGS_SECTIONS.filter(
    (s) =>
      !needle ||
      has(`${s.label} ${s.keywords}`, needle) ||
      (s.groups ?? []).some((g) => has(groupWords(g), needle)),
  );
}

/** Every group whose words contain `q`, by section; none for "". */
export function matchGroups(q: string): { section: SectionKey; group: string }[] {
  const needle = needleOf(q);
  if (!needle) return [];
  return SETTINGS_SECTIONS.flatMap((s) =>
    (s.groups ?? [])
      .filter((g) => has(groupWords(g), needle))
      .map((g) => ({ section: s.key, group: g.key })),
  );
}

/**
 * The group of `section` a search for `q` opens: its first group hit, or none when `q` is
 * empty or the section matched on its own label and keywords.
 */
export function groupOf(section: SectionDef, q: string): string | undefined {
  const needle = needleOf(q);
  if (!needle || has(`${section.label} ${section.keywords}`, needle)) return undefined;
  return section.groups?.find((g) => has(groupWords(g), needle))?.key;
}

export function sectionDef(key: SectionKey): SectionDef {
  return SETTINGS_SECTIONS.find((s) => s.key === key) ?? (SETTINGS_SECTIONS[0] as SectionDef);
}

/**
 * The account row's second line for the Desk's broker identity: the fixed
 * identities `volley auth init` creates, an agent id otherwise, or read-only
 * when the Desk has no credentials.
 */
export function accountRole(identity: string | null, demo: boolean): string {
  if (demo) return "Demo · no broker";
  if (identity === null) return "Read-only · sign in to steer";
  if (identity === "desk") return "Desk · can steer and change settings";
  if (identity === "coordinator") return "Coordinator";
  if (identity === "volleyd") return "Supervisor";
  return "Agent identity";
}
