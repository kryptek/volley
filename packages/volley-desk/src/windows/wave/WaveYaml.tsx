/**
 * The wave file view, ported from the prototype `WaveYaml`: the submitted
 * spec (the wave state's `spec`) rendered back as YAML, one flow mapping per
 * task with its title as a comment.
 */
import type { PipelineStep, WaveStatePayload } from "../../store/types";

const flow = (steps: readonly PipelineStep[]): string =>
  `[${steps.map((s) => (Array.isArray(s) ? flow(s) : s)).join(", ")}]`;

const k = (s: string) => <span className="y-k">{s}</span>;
const v = (s: string) => <span className="y-v">{s}</span>;

export function WaveYaml({ wave }: { wave: WaveStatePayload }) {
  const spec = wave.spec;
  return (
    <pre className="yaml" aria-label="Wave file">
      {k("wave")}: {v(wave.wave)}
      {"\n"}
      {k("release_branch")}: {v(spec?.release_branch ?? wave.release_branch)}
      {"\n"}
      {spec?.model && (
        <>
          {k("model")}: {v(spec.model)}
          {"\n"}
        </>
      )}
      {spec?.pipeline && (
        <>
          {k("pipeline")}: {v(flow(spec.pipeline))}
          {"\n"}
        </>
      )}
      {k("tasks")}:{"\n"}
      {Object.entries(spec?.tasks ?? {}).map(([id, t]) => (
        <span key={id}>
          {"  "}
          {k(id)}: {"{ "}
          {k("issue")}: {v(String(t.issue))}
          {t.after.length ? (
            <>
              , {k("after")}: [{v(t.after.join(", "))}]
            </>
          ) : null}
          {" }"}
          {t.title && <span className="y-c"> # {t.title}</span>}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
