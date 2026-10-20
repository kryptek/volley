/**
 * Settings › About Volley: the version (from this package's `package.json`,
 * which every workspace package shares), the licences and the credits.
 */
import pkg from "../../package.json";

export function About() {
  return (
    <div className="about">
      <div className="about-mark">volley</div>
      <div className="s-hint">Volley {pkg.version} · desk · volleyd · hooks</div>
      <p className="s-hint">Agent coordination over MQTT. Apache-2.0.</p>
      <p className="s-hint">
        Backgrounds by React Bits (MIT + Commons Clause); see THIRD_PARTY_NOTICES.md.
      </p>
    </div>
  );
}
