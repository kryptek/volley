/**
 * Demo-mode steering client: no broker. A publish lands in the store as the
 * envelope it is, then the recipient "answers" through the same reducer the
 * live path uses: the hook's ack to the Desk's mailbox, then the model's
 * `steering_acked` (a coordinator: `resumed`). A daemon control request gets
 * an `ok` ack (an urgent interrupt answers `interrupted: true`;
 * `claude_accounts` and `claude_balance` answer from the demo's Claude
 * registry, so Settings › Claude accounts has profiles to show, and a card's
 * `claude_prime` is answered `ok`;
 * `claude_account_rename` and `claude_account_remove` change that registry,
 * clear a removed profile's usage record and raise the demo's registry-changed
 * signal, so the demo shows the new name and the card leaving). Timings follow
 * the prototype (1.1 s delivered, 2.6 s acked).
 */
import { registryKey } from "../store/claude";
import { DEMO_CLAUDE_REGISTRY, demoClaudeAccounts, demoClaudeBalance } from "../store/fixtures";
import type { DeskMessage, Envelope } from "../store/types";
import { DAEMON_AGENT_ID, type SteerClient, type SteerTransport } from "./transport";

export const DEMO_IDENTITY = "desk";

/**
 * The control ops the demo answers with data of its own: the registry's reads, and the rename
 * and remove it acts out on its own copy of the registry.
 */
const DEMO_OPS: ReadonlySet<string> = new Set([
  "claude_accounts",
  "claude_balance",
  "claude_account_rename",
  "claude_account_remove",
  "claude_prime",
]);

/**
 * The demo's control for the Claude registry only: `claude_accounts`, `claude_balance`,
 * `claude_account_rename`, `claude_account_remove` and `claude_prime` reach the demo client; any other op is
 * refused here, so nothing else in the demo pretends to act.
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

export function createDemoSteerClient(
  apply: (msgs: DeskMessage[]) => void,
  isCoordinator: (agentId: string) => boolean,
  now: () => number = Date.now,
): SteerClient {
  const handlers = new Set<(m: DeskMessage) => void>();
  const emit = (topic: string, envelope: Envelope | null) => {
    const m: DeskMessage = { topic, envelope, receivedAt: now() };
    apply([m]);
    for (const h of handlers) h(m);
  };
  /** The demo's own registry: a rename or remove changes it, and its signal's rev. */
  let registry = DEMO_CLAUDE_REGISTRY.map((r) => ({ ...r }));
  let rev = 0;
  /** Act out a rename or remove; what volleyd would answer, and what it clears. */
  const edit = (req: { op?: unknown; acct?: unknown; label?: unknown }) => {
    const acct = String(req.acct ?? "");
    const row = registry.find((r) => registryKey(r) === acct);
    if (row === undefined) return { result: undefined, cleared: null };
    if (req.op === "claude_account_rename") {
      const label = String(req.label ?? "").trim();
      const same = (r: (typeof registry)[number]) =>
        r === row || (row.email !== undefined && r.email === row.email);
      registry = registry.map((r) => (same(r) ? { ...r, label } : r));
      return {
        result: { acct, label, renamed: registry.filter(same).map(registryKey) },
        cleared: null,
      };
    }
    registry = registry.filter((r) => r !== row);
    return { result: { acct, machine: row.machine, dir_removed: true }, cleared: acct };
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
        const req = env.payload as { op?: unknown; escape_only?: unknown } | undefined;
        const editing = req?.op === "claude_account_rename" || req?.op === "claude_account_remove";
        const edited = editing ? edit(req as Record<string, unknown>) : null;
        // An urgent steer's interrupt (escape_only) "presses Escape" in the demo.
        const result =
          req?.escape_only === true
            ? { interrupted: true }
            : req?.op === "claude_accounts"
              ? { ...demoClaudeAccounts(), accounts: registry }
              : req?.op === "claude_balance"
                ? demoClaudeBalance()
                : edited?.result;
        const answer = { text: "ACKED", ok: true, ...(result ? { result } : {}) };
        setTimeout(() => {
          emit(self, reply(DAEMON_AGENT_ID, ns, "mailbox", "ack", answer, id));
          if (edited?.result === undefined) return;
          // What volleyd does next: the removed profile's record cleared, the signal raised.
          if (edited.cleared !== null)
            emit(`volley/_system/claude-accounts/${edited.cleared}`, null);
          rev++;
          emit(
            "volley/_system/claude/registry",
            reply(DAEMON_AGENT_ID, ns, "_system/claude", "claude_registry_changed", {
              rev,
              at: new Date(now()).toISOString(),
            }),
          );
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
