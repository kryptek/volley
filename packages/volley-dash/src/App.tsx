import { Dashboard } from "./components/Dashboard";

/**
 * Top-level app shell. Phase 0 is scaffold-only — Phase 1 wires the MQTT
 * data layer + reducer context provider here, Phase 2 fills out the visual
 * tree underneath `<Dashboard />`.
 */
export function App(): JSX.Element {
  return <Dashboard />;
}
