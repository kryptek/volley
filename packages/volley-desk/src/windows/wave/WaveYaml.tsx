/**
 * The wave file view, ported from the prototype `WaveYaml`: the submitted
 * spec (from the wave state's `spec`) rendered back as YAML, one flow-mapping
 * line per task with its title as a comment, and the spec version as `v<n>`.
 */
import type { PipelineStep, WaveStatePayload } from "../../store/types";

const flow = (steps: readonly PipelineStep[]): string =>
  `[${steps.map((s) => (Array.isArray(s) ? flow(s) : s)).join(", ")}]`;

function Line({ k, v, c, indent = 0 }: { k: string; v?: string; c?: string; indent?: number }) {
  return (
    <div>
      {"  ".repeat(indent)}
      <span className="y-k">{k}:</span>
      {v !== undefined && <span className="y-v"> {v}</span>}
      {c && <span className="y-c"> # {c}</span>}
    </div>
  );
}

export function WaveYaml({ wave }: { wave: WaveStatePayload }) {
  const spec = wave.spec;
  return (
    <div className="yaml-wrap">
      <div className="lbl">
        <span>wave file</span>
        <span className="chip">v{spec?.version ?? wave.version}</span>
      </div>
      {spec ? (
        <pre className="yaml mono">
          <Line k="wave" v={wave.wave} />
          <Line k="release_branch" v={spec.release_branch ?? wave.release_branch} />
          {spec.model && <Line k="model" v={spec.model} />}
          {spec.pipeline && <Line k="pipeline" v={flow(spec.pipeline)} />}
          <Line k="tasks" />
          {Object.entries(spec.tasks).map(([id, t]) => (
            <Line
              key={id}
              indent={1}
              k={id}
              v={`{ issue: ${t.issue}, after: [${t.after.join(", ")}] }`}
              {...(t.title ? { c: t.title } : {})}
            />
          ))}
        </pre>
      ) : (
        <div className="dim">The supervisor has not published this wave's file.</div>
      )}
    </div>
  );
}
