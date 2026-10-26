/**
 * Settings › About Volley: the version (from this package's `package.json`,
 * which every workspace package shares), the broker the Desk connects to and
 * where that came from (the server's `/desk-config.json`, or the page's host),
 * where to report a problem (`volley bug`, run in a terminal: the Desk cannot
 * gather the diagnostics itself), the licences and the credits.
 */
import { useContext } from "react";
import pkg from "../../package.json";
import { BrokerOriginContext } from "../store/context";
import { CopyText } from "./onboardingParts";

export function About() {
  const origin = useContext(BrokerOriginContext);
  return (
    <div className="about">
      <div className="about-mark">volley</div>
      <div className="s-hint">Volley {pkg.version} · desk · volleyd · hooks</div>
      {origin !== null && (
        <div className="s-hint mono">{`broker ${origin.url} (${origin.source})`}</div>
      )}
      <p className="s-hint about-bug">
        Something wrong? Run <CopyText text="volley bug" /> in a terminal: it gathers and redacts
        the diagnostics and opens an issue
      </p>
      <p className="s-hint">Agent coordination over MQTT. Apache-2.0.</p>
      <p className="s-hint">
        Backgrounds by React Bits (MIT + Commons Clause); see THIRD_PARTY_NOTICES.md.
      </p>
    </div>
  );
}
