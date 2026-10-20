/**
 * The Settings window's sections, ported from the prototype `settings.tsx`
 * (`SECTIONS`): the sidebar label, the coloured icon tile, the sidebar group
 * and the extra words the sidebar search matches.
 */
import {
  ComputerIcon,
  DashboardSpeed01Icon,
  InformationCircleIcon,
  Key01Icon,
  PaintBoardIcon,
  Rocket01Icon,
  ServerStack01Icon,
  Settings02Icon,
  VolumeHighIcon,
} from "@hugeicons/core-free-icons";

export type SectionKey =
  | "general"
  | "sound"
  | "appearance"
  | "supervisor"
  | "claude"
  | "accounts"
  | "machines"
  | "setup"
  | "about";

export interface SectionDef {
  key: SectionKey;
  label: string;
  icon: typeof Settings02Icon;
  tint: string;
  /** The sidebar group (0–2), drawn as separate lists. */
  group: 0 | 1 | 2;
  keywords: string;
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
    keywords: "sound theme volume mute audition quiet hours vibrate chime",
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
    keywords: "ceiling leases admission memory escalate heartbeat claim model",
  },
  {
    key: "claude",
    label: "Claude accounts & usage",
    icon: DashboardSpeed01Icon,
    tint: "#d97757",
    group: 1,
    keywords: "claude usage limit 5h weekly plan max 20x switch account tokens",
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
    keywords: "peer pair add machine tunnel host",
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

/** The sections whose label or keywords contain `q` (case-insensitive); all of them for "". */
export function matchSections(q: string): SectionDef[] {
  const needle = q.trim().toLowerCase();
  return SETTINGS_SECTIONS.filter(
    (s) => !needle || `${s.label} ${s.keywords}`.toLowerCase().includes(needle),
  );
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
