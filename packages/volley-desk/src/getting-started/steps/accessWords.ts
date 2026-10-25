/**
 * The words Getting started › Access and You're good to go! use for the two choices Access makes:
 * the private network (`volley setup`'s Network step, SPEC §4.6.10) and the coordinator's machine
 * (`coordinator.machine`, SPEC §4.6.25). Pure.
 */
import { LOCAL_COORDINATOR } from "../../settings/CoordinatorCard";
import type { Summary } from "../state";

export type NetworkChoice = NonNullable<Summary["network"]>;

/** The report line the Network step's Tailscale sign-in leaves (SPEC §4.6.10), and its URL. */
export const TAILSCALE_SIGN_IN = /^Sign in to Tailscale: (https:\/\/\S+)$/;

/** The sign-in URL in a report line, or `null` when the line is not a Tailscale sign-in. */
export function tailscaleSignIn(line: string): string | null {
  return TAILSCALE_SIGN_IN.exec(line)?.[1] ?? null;
}

/**
 * The machine the coordinator runs on as a person reads it: `local` is this computer (its name
 * when known); `null` (off) and `undefined` (not picked) are `null`.
 */
export function coordinatorName(
  coordinator: string | null | undefined,
  thisMachine: string | undefined,
): string | null {
  if (coordinator === null || coordinator === undefined) return null;
  return coordinator === LOCAL_COORDINATOR ? (thisMachine ?? "this computer") : coordinator;
}

/** The machine whose network a VPN reaches: the coordinator's, else this computer. */
export function vpnMachine(s: Pick<Summary, "machine" | "coordinatorMachine">): string {
  return coordinatorName(s.coordinatorMachine, s.machine) ?? s.machine ?? "this computer";
}

/** The radio's label for each choice. */
export function networkLabel(kind: NetworkChoice, machine: string): string {
  switch (kind) {
    case "tailscale":
      return "Tailscale";
    case "manual":
      return `I'll VPN in to the network ${machine} is on`;
    case "none":
      return "This network only";
  }
}

/** What each choice means, under its label. */
export const NETWORK_WHAT: Record<NetworkChoice, string> = {
  tailscale:
    "A private network between your devices, free for personal use. Volley installs it here and signs this computer in; nothing is opened to the internet.",
  manual:
    "You already run a VPN (WireGuard, OpenVPN, your router's) into that network. Tell Volley this computer's address on it.",
  none: "The Desk works on this Wi-Fi only. Away from home, nothing reaches it.",
};

/** The summary's "Away from home" row. */
export function networkSummary(s: Summary): string | null {
  if (s.network === undefined) return null;
  return s.network === "manual"
    ? `VPN to ${vpnMachine(s)}'s network`
    : networkLabel(s.network, vpnMachine(s));
}

/** The summary's "Coordinator" row: the machine, `off`, or `null` while no step learnt it. */
export function coordinatorSummary(s: Summary): string | null {
  if (s.coordinatorMachine === undefined) return null;
  return coordinatorName(s.coordinatorMachine, s.machine) ?? "off";
}
