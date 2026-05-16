/**
 * EmptyState — replaces the AgentGrid when no agents are registered.
 *
 * Renders the box-drawing ASCII wordmark + tag line referencing the
 * retained-registry topic + a hint card with `$` and `›` prompt examples
 * for the common dispatch invocations (per handoff §"Empty state").
 */
import { ASCII_VOLLEY } from "../lib/ascii";

export interface EmptyStateProps {
  brokerUrl?: string | undefined;
}

export function EmptyState({
  brokerUrl = "mqtt://broker.local:9001",
}: EmptyStateProps = {}): JSX.Element {
  return (
    <div data-testid="empty-state" className="vd-empty">
      <pre data-testid="ascii-wordmark" className="vd-ascii">
        {ASCII_VOLLEY}
      </pre>
      <div className="vd-tag-line">
        no agents registered · waiting for retained entries on volley/+/_system/registry/+
      </div>
      <div data-testid="empty-hint-card" className="vd-hint">
        <div>
          <span className="vd-prompt">$</span>{" "}
          <code>npx volley dispatch ./tasks/refactor-auth.md --ns default</code>
        </div>
        <div style={{ color: "var(--fg-4)", marginTop: 6 }}>or, from a script:</div>
        <div>
          <span className="vd-prompt">›</span>{" "}
          <code>{`mosquitto_pub -t volley/default/my-agent/status -m '{"state":"working"}'`}</code>
        </div>
        <div style={{ color: "var(--fg-4)", marginTop: 6, fontSize: 11 }}>broker: {brokerUrl}</div>
      </div>
    </div>
  );
}
