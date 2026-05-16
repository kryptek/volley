/**
 * Dashboard — top-level grid shell. Mounts the `DashboardProvider` (so the
 * MQTT lifecycle is owned at this boundary), reads state out via
 * `useDashboard`, threads it as props down to TopBar / AgentGrid / LiveFeed
 * / AgentDrawer.
 *
 * Layout (from `globals.css` `[data-volley-app]`):
 *   "topbar topbar"     48px
 *   "main   rail"       1fr / (1fr | 340px)
 *
 * The drawer is mounted at the dashboard level (not inside main) so it
 * overlays the main column without unmounting it — handoff §"Drawer
 * behavior" requires the grid to keep updating live behind the drawer.
 *
 * Phase 2: Esc closes the drawer. The `/` keystroke focus for search is
 * handled inside TopBar.
 */
import { useEffect, useMemo } from "react";
import { useNow } from "../hooks/use-now";
import type { VolleyMqttClient } from "../lib/mqtt-client";
import { DashboardProvider, useDashboard } from "../state/dashboard-context";
import { AgentDrawer } from "./AgentDrawer";
import { AgentGrid } from "./AgentGrid";
import { EmptyState } from "./EmptyState";
import { LiveFeed } from "./LiveFeed";
import { TopBar } from "./TopBar";

export interface DashboardProps {
  brokerUrl?: string | undefined;
  clientFactory?: ((url: string) => VolleyMqttClient) | undefined;
}

export function Dashboard({ brokerUrl, clientFactory }: DashboardProps = {}): JSX.Element {
  return (
    <DashboardProvider brokerUrl={brokerUrl} clientFactory={clientFactory}>
      <DashboardShell />
    </DashboardProvider>
  );
}

function DashboardShell(): JSX.Element {
  const { state, dispatch, brokerStatus, brokerUrl } = useDashboard();
  const now = useNow();

  const agents = useMemo(() => Array.from(state.agents.values()), [state.agents]);
  const nsScoped = useMemo(
    () => (state.ns === "all" ? agents : agents.filter((a) => a.ns === state.ns)),
    [agents, state.ns],
  );
  const namespaces = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents) set.add(a.ns);
    return Array.from(set).sort();
  }, [agents]);
  const agentCounts = useMemo(() => {
    const m: Record<string, number> = { all: agents.length };
    for (const n of namespaces) m[n] = agents.filter((a) => a.ns === n).length;
    return m;
  }, [agents, namespaces]);
  const workingCount = useMemo(() => agents.filter((a) => a.status === "working").length, [agents]);
  const stuckCount = useMemo(
    () => agents.filter((a) => a.status === "blocked" || a.status === "failed").length,
    [agents],
  );

  const selectedAgent =
    state.selectedId !== null ? (state.agents.get(state.selectedId) ?? null) : null;

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape" && state.selectedId !== null) {
        dispatch({ type: "SELECT_AGENT", id: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, state.selectedId]);

  return (
    <div data-testid="dashboard" data-volley-app>
      <TopBar
        namespaces={namespaces}
        ns={state.ns}
        setNs={(next) => dispatch({ type: "FILTER_NAMESPACE", ns: next })}
        agentCounts={agentCounts}
        workingCount={workingCount}
        stuckCount={stuckCount}
        brokerStatus={brokerStatus}
        brokerUrl={brokerUrl}
        query={state.query}
        setQuery={(next) => dispatch({ type: "FILTER_QUERY", query: next })}
      />
      <main className="vd-main">
        {agents.length === 0 ? (
          <>
            <AgentGrid
              agents={[]}
              filter={state.statusFilter}
              setFilter={(next) => dispatch({ type: "FILTER_STATUS", status: next })}
              query={state.query}
              now={now}
            />
            <EmptyState brokerUrl={brokerUrl} />
          </>
        ) : (
          <AgentGrid
            agents={nsScoped}
            filter={state.statusFilter}
            setFilter={(next) => dispatch({ type: "FILTER_STATUS", status: next })}
            query={state.query}
            selectedId={state.selectedId}
            onSelect={(id) => dispatch({ type: "SELECT_AGENT", id })}
            now={now}
            totalCount={agents.length}
          />
        )}
      </main>
      <LiveFeed
        events={state.events}
        paused={state.paused}
        setPaused={() => dispatch({ type: "TOGGLE_PAUSE" })}
        channelFilter={state.channelFilter}
        setChannelFilter={(next) => dispatch({ type: "CHANNEL_FILTER_SET", channel: next })}
      />
      {selectedAgent !== null && (
        <AgentDrawer
          agent={selectedAgent}
          events={state.events}
          now={now}
          onClose={() => dispatch({ type: "SELECT_AGENT", id: null })}
        />
      )}
    </div>
  );
}
