import { vi } from "vitest";
import type { AuthAnswer, AuthOps } from "../../src/store/control";

/** A fake admin channel: each op answers from `handlers`, anything else is an unknown op. */
export function fakeOps(
  handlers: Record<string, (fields: Record<string, unknown>) => AuthAnswer | Promise<AuthAnswer>>,
) {
  const calls: { op: string; fields: Record<string, unknown> }[] = [];
  const ops: AuthOps = {
    identity: "admin-0123abcd",
    request: vi.fn(async (op: string, fields: Record<string, unknown> = {}) => {
      calls.push({ op, fields });
      const h = handlers[op];
      return h ? h(fields) : { ok: false, error: `unknown op '${op}'` };
    }),
  };
  return { ops, calls };
}

export const PLAN = {
  steps: [
    {
      step: "detect",
      title: "Broker",
      found: [
        "mosquitto 2.1.2 (from mosquitto -h)",
        "Listener 1883: refuses anonymous clients",
        "Listener 9001: refuses anonymous clients",
        "3 agents running on the broker",
      ],
      changes: [],
    },
    {
      step: "security",
      title: "Security",
      found: ["/etc/mosquitto/mosquitto.conf is not Volley's Dynamic Security config"],
      changes: [
        {
          summary: "Write Volley's Dynamic Security config (the old one is kept as a backup)",
          detail: "--- mosquitto.conf\n+++ mosquitto.conf\n+plugin dynamic-security",
        },
        { summary: "Restart the broker (about 2 s; agents reconnect on their own)" },
      ],
    },
    {
      step: "accounts",
      title: "Accounts",
      found: ["Volley's shared roles are on the broker"],
      changes: [
        {
          summary:
            "Issue a one-time admin token (10 minutes, single use) to sign in to the Desk as admin",
        },
      ],
    },
    {
      step: "services",
      title: "Services",
      found: ["volleyd runs as a login service"],
      changes: [],
    },
    {
      step: "phone",
      title: "Phone",
      found: [],
      changes: [{ summary: 'Issue a one-time steer sign-in link for "Desk on phone"' }],
    },
  ],
  last_setup: "2026-10-18T22:12:00Z",
};
