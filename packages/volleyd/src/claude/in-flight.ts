/**
 * The balance's reservations (SPEC §4.6.12): each agent the supervisor has picked an account
 * for and that has not reported usage yet counts against that account, so the picks of one
 * spawn pass see each other before any new sample lands. A reservation is made at the pick
 * (keyed by its role, `<wave>/<task>/<role>`, until the launch names the agent), moves to the
 * agent's id once it is launched, and goes when the agent's first usage sample is folded, when it
 * is retired, or when the spawn fails. Kept in memory only: after a restart the agents are
 * running and counted by their spawn records. Pure.
 */

interface Reservation {
  /** The usage-record key of the account it counts against. */
  account: string;
  wave: string;
  task: string;
  role: string;
}

export const roleKey = (wave: string, task: string, role: string) => `${wave}/${task}/${role}`;

export class InFlightLedger {
  private readonly held = new Map<string, Reservation>();

  /** A pick of `account` for the role's next agent (replaces one the role already held). */
  reserve(wave: string, task: string, role: string, account: string): void {
    this.held.set(roleKey(wave, task, role), { account, wave, task, role });
  }

  /** The role's spawn launched `agentId`: its reservation is now the agent's. */
  launched(wave: string, task: string, role: string, agentId: string): void {
    const key = roleKey(wave, task, role);
    const r = this.held.get(key);
    if (r === undefined) return;
    this.held.delete(key);
    this.held.set(agentId, r);
  }

  /** The agent reported usage, or was retired: it is no longer a reservation. */
  release(agentId: string): void {
    this.held.delete(agentId);
  }

  /**
   * The role's spawn failed or launched no agent: its pending reservation goes (an agent already
   * running in the role keeps its own: an extra spawn refused as locked is not that agent's).
   */
  failed(wave: string, task: string, role: string): void {
    this.held.delete(roleKey(wave, task, role));
  }

  /** The reservations against `account`: agent ids, and role keys of spawns still launching. */
  on(account: string): string[] {
    return [...this.held].filter(([, r]) => r.account === account).map(([id]) => id);
  }
}
