/**
 * The words Getting started › People uses for the account roles that exist (SPEC §4.6.10): no
 * new role, only friendlier names. Superuser is `admin`, Standard is `steer`, Viewer is `watch`.
 */
import type { PersonRole } from "../state";

export interface RoleWord {
  word: "Standard" | "Superuser" | "Viewer";
  role: PersonRole;
  /** What the role may do, under the choice. */
  what: string;
}

/** The choices in the order the invite form offers them (Standard first, the default). */
export const ROLE_WORDS: readonly RoleWord[] = [
  { word: "Standard", role: "steer", what: "Starts waves, answers questions, watches progress" },
  { word: "Superuser", role: "admin", what: "Also changes settings, machines and accounts" },
  { word: "Viewer", role: "watch", what: "Only watches" },
];

export const roleFromWord = (word: RoleWord["word"]): PersonRole =>
  ROLE_WORDS.find((w) => w.word === word)?.role ?? "steer";

/** The wizard's word for an account role; null for one that is not a person's (`peer`, `agent`). */
export function wordOfRole(role: string): RoleWord["word"] | null {
  return ROLE_WORDS.find((w) => w.role === role)?.word ?? null;
}
