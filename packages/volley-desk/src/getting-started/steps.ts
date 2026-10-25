/**
 * The Getting started registry: the seven steps in order, each with its rail title and subtitle,
 * the stage's heading and lede, and the body G2–G4 fill in. The shell hosts the steps and holds
 * no step logic; a step that changes something does it through volleyd's existing ops, showing
 * what it will change before it applies it.
 */
import type { ComponentType, ReactNode } from "react";
import type { ConfigTransport } from "../settings/configTransport";
import type { SectionKey } from "../settings/sections";
import type { SteerTransport } from "../steer/transport";
import type { AuthOps } from "../store/control";
import type { PeerOps } from "../store/peerOps";
import type { DeskState } from "../store/types";
import type { SceneId } from "./art/ids";
import type { Summary } from "./state";
import { Access } from "./steps/Access";
import { Done } from "./steps/Done";
import { Machines } from "./steps/Machines";
import { People } from "./steps/People";
import { Repos } from "./steps/Repos";
import { ThisComputer } from "./steps/ThisComputer";
import { Welcome } from "./steps/Welcome";

/** The Desk's control router (`routeDeskControl`): volleyd's mailbox ops. */
export type DeskControl = SteerTransport["control"];

/** What every step can reach: the Desk's channels to volleyd and its state. */
export interface WizardContext {
  /** volleyd's admin channel (`createAuthOps`). */
  ops: AuthOps;
  control: DeskControl | null;
  state: DeskState;
  /** This Desk's URL without a fragment. */
  deskUrl: string;
  identity: string | null;
  /** Pause Getting started and open a Settings section. */
  openSettings(section: SectionKey): void;
  /** volleyd's config channel (`config_set`); absent: the name is read-only. */
  config?: ConfigTransport | null;
  /** The pairing ops (`createPeerOps`); absent: made over `ops`. */
  peerOps?: PeerOps | null;
  /** This machine's host as the Desk reaches it (`sshHost`), for the ssh address's placeholder. */
  sshHost?: string;
  /** A paired machine's remote Claude sign-in button, as Settings › Machines has it. */
  signIn?: (machine: string) => ReactNode;
  /** Clock override (tests). */
  now?: number;
}

export interface StepProps {
  ctx: WizardContext;
  summary: Summary;
  setSummary(patch: Partial<Summary>): void;
  /** Move on to the next step (what the footer's primary button does). */
  onContinue(): void;
  /** Skip Getting started for now (Welcome offers it). */
  onSkip?(): void;
}

export interface StepDef {
  id: SceneId;
  title: string;
  subtitle: string;
  heading: string;
  lede: string;
  Body: ComponentType<StepProps>;
}

export const STEPS: readonly StepDef[] = [
  {
    id: "welcome",
    title: "Welcome",
    subtitle: "What Volley does",
    heading: "Let's get your first wave in the air.",
    lede: "Volley coordinates your development waves across your repos: it hands GitHub issues to Claude agents, reviews their work, and merges what passes. This takes about ten minutes. Nothing changes until you say so.",
    Body: Welcome,
  },
  {
    id: "this-computer",
    title: "This computer",
    subtitle: "Install and check",
    heading: "Setting up this computer.",
    lede: "What the install found and installed here, and the setup it still has to apply: Volley shows each change before it makes it.",
    Body: ThisComputer,
  },
  {
    id: "machines",
    title: "Your machines",
    subtitle: "Add more computers",
    heading: "Add your other computers.",
    lede: "Agents can run on any computer you pair. Pair one now, or later from Settings › Machines.",
    Body: Machines,
  },
  {
    id: "repos",
    title: "Repos",
    subtitle: "GitHub and projects",
    heading: "Connect GitHub and your repos.",
    lede: "Volley works from GitHub issues: sign in to GitHub and pick the repositories your waves run in.",
    Body: Repos,
  },
  {
    id: "people",
    title: "People",
    subtitle: "Accounts and roles",
    heading: "Invite the people who steer.",
    lede: "Give each person their own sign-in: an admin changes setup, a steerer answers agents, a watcher only looks.",
    Body: People,
  },
  {
    id: "access",
    title: "Access",
    subtitle: "Reach it from anywhere",
    heading: "Reach it from anywhere.",
    lede: "Open the Desk from your phone or away from home: Tailscale is the simplest way, and an address of your own works too.",
    Body: Access,
  },
  {
    id: "done",
    title: "Done",
    subtitle: "You're good to go",
    heading: "You're good to go!",
    lede: "Here is what is set up. Change any of it later in Settings.",
    Body: Done,
  },
];
