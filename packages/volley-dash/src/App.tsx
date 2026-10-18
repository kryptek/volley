import { LoginGate } from "./components/LoginGate";

/**
 * Top-level app shell. The broker requires credentials, so the dashboard
 * mounts behind the LoginGate, which renders `<Dashboard />` once signed in.
 */
export function App(): JSX.Element {
  return <LoginGate />;
}
