/**
 * Demo-mode steering client: no broker. A publish lands in the store as the
 * envelope it is, then the recipient "answers" through the same reducer the
 * live path uses: the hook's ack to the Desk's mailbox, then the model's
 * `steering_acked` (a coordinator: `resumed`). A daemon control request gets
 * an `ok` ack (an urgent interrupt answers `interrupted: true`;
 * `claude_accounts` and `claude_balance` answer from the demo's Claude
 * registry, so Settings › Claude accounts has profiles to show; `wave_account_set`
 * re-publishes the demo wave's state with its new `account`, as volleyd would). Timings
 * follow the prototype (1.1 s delivered, 2.6 s acked).
 */
import { demoClaudeAccounts, demoClaudeBalance } from "../store/fixtures";
import type { DeskMessage, Envelope, WaveAccount, WaveStatePayload } from "../store/types";
import { DAEMON_AGENT_ID, type SteerClient, type SteerTransport } from "./transport";

export const DEMO_IDENTITY = "desk";

/**
 * The control ops the demo answers with data of its own: reads, which change nothing, and the
 * wave's account, which changes only the demo's own wave state.
 */
const DEMO_OPS: ReadonlySet<string> = new Set([
  "claude_accounts",
  "claude_balance",
  "wave_account_set",
]);

/**
 * The demo's control: `claude_accounts`, `claude_balance` and `wave_account_set` reach the demo
 * client; any other op is refused here, so nothing else in the demo pretends to act.
 */
export function demoReadControl(control: SteerTransport["control"]): SteerTransport["control"] {
  return (op, fields, text, timeoutMs) =>
    DEMO_OPS.has(op)
      ? control(op, fields, text, timeoutMs)
      : Promise.resolve({ ok: false, error: "demo mode: nothing to answer it" });
}
const DELIVER_MS = 1100;
const ACT_MS = 2600;
const CONTROL_MS = 600;

/** A wave state after `wave_account_set { acct }`, as volleyd publishes it (SPEC §4.6.1). */
export function withWaveAccount(s: WaveStatePayload, acct: string | null): WaveStatePayload {
  const from = s.account?.pinned ?? null;
  const account: WaveAccount = {
    pinned: acct,
    source: acct === null ? "balanced" : "wave",
    ...(from !== null ? { moved_from: from } : {}),
  };
  return { ...s, account };
}

export function createDemoSteerClient(
  apply: (msgs: DeskMessage[]) => void,
  isCoordinator: (agentId: string) => boolean,
  now: () => number = Date.now,
  /** The demo's current wave state, for `wave_account_set` to re-publish. */
  waveState: (wave: string) => WaveStatePayload | null = () => null,
): SteerClient {
  const handlers = new Set<(m: DeskMessage) => void>();
  const emit = (topic: string, envelope: Envelope) => {
    const m: DeskMessage = { topic, envelope, receivedAt: now() };
    apply([m]);
    for (const h of handlers) h(m);
  };
  const reply = (
    from: string,
    ns: string,
    channel: string,
    type: string,
    payload: unknown,
    id: string | null = null,
  ): Envelope => ({
    schema_version: "0.1",
    agent_id: from,
    parent_id: null,
    namespace: ns,
    channel,
    type,
    wall_time: new Date(now()).toISOString(),
    correlation_id: id,
    payload,
  });
  return {
    async publish(topic, payload) {
      const env = JSON.parse(payload) as Envelope;
      const [, ns = "default", to = ""] = topic.split("/");
      const id = env.correlation_id ?? null;
      const self = `volley/${ns}/${env.agent_id}/mailbox`;
      if (to === DAEMON_AGENT_ID) {
        const req = env.payload as
          | { op?: unknown; escape_only?: unknown; wave?: unknown; acct?: unknown }
          | undefined;
        const moved =
          req?.op === "wave_account_set" && typeof req.wave === "string"
            ? waveState(req.wave)
            : null;
        // An urgent steer's interrupt (escape_only) "presses Escape" in the demo.
        const result =
          req?.escape_only === true
            ? { interrupted: true }
            : req?.op === "claude_accounts"
              ? demoClaudeAccounts()
              : req?.op === "claude_balance"
                ? demoClaudeBalance()
                : undefined;
        const answer = { text: "ACKED", ok: true, ...(result ? { result } : {}) };
        setTimeout(() => {
          // The new account is in the wave state before the answer, as volleyd journals first.
          if (moved !== null)
            emit(
              `volley/_waves/${moved.wave}/state`,
              reply(
                DAEMON_AGENT_ID,
                ns,
                "_waves/state",
                "wave_state",
                withWaveAccount(moved, typeof req?.acct === "string" ? req.acct : null),
              ),
            );
          emit(self, reply(DAEMON_AGENT_ID, ns, "mailbox", "ack", answer, id));
        }, CONTROL_MS);
        return;
      }
      emit(topic, env);
      setTimeout(() => {
        emit(self, reply(to, ns, "mailbox", "ack", { text: "ACKED", acked_type: env.type }, id));
      }, DELIVER_MS);
      setTimeout(() => {
        const text = String((env.payload as { text?: unknown } | undefined)?.text ?? "");
        emit(
          `volley/${ns}/${to}/progress`,
          isCoordinator(to)
            ? reply(to, ns, "progress", "resumed", { source: "harness-hook" })
            : reply(
                to,
                ns,
                "progress",
                "steering_acked",
                { msg: `Acknowledged: ${text.toLowerCase()}` },
                id,
              ),
        );
      }, ACT_MS);
    },
    onMessage(h) {
      handlers.add(h);
      return () => {
        handlers.delete(h);
      };
    },
  };
}
