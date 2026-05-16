/**
 * Lookup tables ported verbatim from the design handoff (`volley-data.jsx`):
 * status color/label, channel color/short-tag, and sort priority.
 *
 * Colors reference CSS custom properties defined in `styles/globals.css`
 * (e.g. `--st-working`); a few channel colors are inline OKLCH per the
 * handoff's intent that channel tags read distinctly from status.
 */
import type { AgentStatus, ChannelKind } from "../types";

export interface StatusMeta {
  color: string;
  label: string;
}

export const STATUS_META: Record<AgentStatus, StatusMeta> = {
  spawning: { color: "var(--st-spawning)", label: "spawning" },
  registered: { color: "var(--st-registered)", label: "registered" },
  working: { color: "var(--st-working)", label: "working" },
  done: { color: "var(--st-done)", label: "done" },
  blocked: { color: "var(--st-blocked)", label: "blocked" },
  failed: { color: "var(--st-failed)", label: "failed" },
  reaped: { color: "var(--st-reaped)", label: "reaped" },
};

export interface ChannelMeta {
  color: string;
  short: string;
}

export const CHANNEL_META: Record<ChannelKind, ChannelMeta> = {
  status: { color: "oklch(0.78 0.10 240)", short: "st" },
  progress: { color: "oklch(0.82 0.16 165)", short: "pr" },
  mailbox: { color: "oklch(0.83 0.16 75)", short: "mb" },
  result: { color: "oklch(0.85 0.13 200)", short: "rs" },
  system: { color: "oklch(0.58 0.010 280)", short: "sy" },
};

/**
 * Top-to-bottom sort priority in the grid (handoff README §Color/status,
 * Plan 8 Phase 2 §AgentGrid sort, and Phase 1 brief #3 all agree).
 * Within a status, sort by lastSeen ascending (most recently active first).
 *
 * Differs from handoff `volley-data.jsx`'s STATUS_ORDER constant — the
 * data-source-of-truth and prose-source-of-truth disagreed; prose is canonical
 * (3-of-4 spec sources put `spawning` second). Spec reviewer flagged this in
 * Phase 1 review; fixed before Phase 2 inherits the bug.
 */
export const STATUS_ORDER: AgentStatus[] = [
  "working",
  "spawning",
  "blocked",
  "failed",
  "registered",
  "done",
  "reaped",
];
