/**
 * A release item (`kind: "release"`, SPEC §4.6.19) rendered natively from the train's evidence:
 * a `Stepper` of the wave state's `release.stages` (each stage's state in its title, the stage in
 * play current), the changelog entries that will ship (the stage evidence JSON's
 * `artifacts.changelog_entries`, through the safe inline Markdown renderer), the staging smoke
 * screenshots (`artifacts.screenshots`) and links to the release PR, the CI runs, the smoke log
 * and the evidence itself. Files under the evidence folder come from the Desk's own server
 * (`volley desk serve --evidence`, `GET /evidence/<wave>/release/<file>`); the URL is built from
 * the Desk's origin and the file's base name only. An external release guide
 * (`artifacts.guide_url`) is only ever a link: the Desk never embeds or depends on it.
 *
 * The item's `source.evidence.json` is the evidence JSON's path on volleyd's machine (only its
 * base name is used), or the evidence object itself.
 */
import { useEffect, useState } from "react";
import { renderInlineMarkdown } from "../../lib/markdown";
import Stepper, { Step } from "../../rb/Stepper/Stepper";
import type { InboxItem, WaveRelease, WaveView } from "../../store/types";

/** What the Desk reads from a stage's evidence JSON (`artifacts`); every field optional. */
export interface ReleaseArtifacts {
  changelog_entries?: string[];
  screenshots?: string[];
  release_pr?: string;
  ci_runs?: string[];
  smoke_log?: string;
  guide_url?: string;
}

export type LoadEvidence = (url: string) => Promise<unknown>;

export interface ReleaseItemProps {
  item: InboxItem;
  wave?: WaveView | undefined;
  /** The Desk's origin (default: this page's). */
  origin?: string;
  /** Fetches the evidence JSON (default: `fetch`, JSON or null). */
  loadEvidence?: LoadEvidence;
}

const STATE_LABEL: Record<WaveRelease["stages"][number]["state"], string> = {
  pending: "pending",
  awaiting_go: "awaiting go",
  running: "running",
  verified: "verified",
  failed: "failed",
  skipped: "skipped",
};

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? "";

/** `<origin>/evidence/<wave>/release/<file>`, `file` reduced to its base name. */
export function evidenceUrl(origin: string, wave: string, file: string): string {
  return `${origin}/evidence/${encodeURIComponent(wave)}/release/${encodeURIComponent(baseName(file))}`;
}

const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The `artifacts` of an evidence JSON, keeping only well-typed fields. */
export function releaseArtifacts(evidence: unknown): ReleaseArtifacts {
  const a = (evidence as { artifacts?: Record<string, unknown> } | null)?.artifacts;
  if (typeof a !== "object" || a === null) return {};
  return {
    changelog_entries: strings(a.changelog_entries),
    screenshots: strings(a.screenshots).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)),
    ...(isHttp(a.release_pr) ? { release_pr: a.release_pr } : {}),
    ci_runs: strings(a.ci_runs).filter(isHttp),
    ...(typeof a.smoke_log === "string" ? { smoke_log: a.smoke_log } : {}),
    ...(isHttp(a.guide_url) ? { guide_url: a.guide_url } : {}),
  };
}

const fetchJson: LoadEvidence = async (url) => {
  const r = await fetch(url);
  return r.ok ? r.json() : null;
};

/** The step in play: the train's stage, else the first not verified; past the end once all are. */
function currentStep(release: WaveRelease): number {
  const at = release.stages.findIndex((s) => s.name === release.stage);
  if (at >= 0) return at + 1;
  const open = release.stages.findIndex((s) => s.state !== "verified");
  return open >= 0 ? open + 1 : release.stages.length + 1;
}

export function ReleaseItem(p: ReleaseItemProps) {
  const origin = p.origin ?? window.location.origin;
  const source = p.item.source as { wave?: unknown; evidence?: { md?: unknown; json?: unknown } };
  const wave = typeof source.wave === "string" ? source.wave : p.item.wave;
  const json = source.evidence?.json;
  const md = source.evidence?.md;
  const jsonUrl =
    typeof json === "string" && wave !== undefined ? evidenceUrl(origin, wave, json) : null;
  // Inline evidence is read from props on every render; state holds only what was fetched.
  const [fetched, setFetched] = useState<unknown>(null);
  const loaded = typeof json === "object" && json !== null ? json : fetched;
  const load = p.loadEvidence ?? fetchJson;
  useEffect(() => {
    if (jsonUrl === null) return;
    let live = true;
    load(jsonUrl)
      .then((e) => {
        if (live) setFetched(e);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [jsonUrl, load]);

  const a = releaseArtifacts(loaded);
  const release = p.wave?.state?.release;
  const file = (f: string) => (wave !== undefined ? evidenceUrl(origin, wave, f) : null);
  const smoke =
    a.smoke_log !== undefined ? (isHttp(a.smoke_log) ? a.smoke_log : file(a.smoke_log)) : null;
  const evidenceMd = typeof md === "string" ? file(md) : null;
  const links = [
    ...(a.release_pr ? [{ href: a.release_pr, label: "Release PR" }] : []),
    ...(a.ci_runs ?? []).map((href, i, all) => ({
      href,
      label: all.length > 1 ? `CI run ${i + 1}` : "CI run",
    })),
    ...(smoke ? [{ href: smoke, label: "Smoke log" }] : []),
    ...(evidenceMd ? [{ href: evidenceMd, label: "Evidence" }] : []),
    ...(a.guide_url ? [{ href: a.guide_url, label: "Release guide" }] : []),
  ];

  return (
    <div className="inbox-release">
      {release && release.stages.length > 0 && (
        <Stepper
          className="inbox-train"
          aria-label="Release train"
          step={currentStep(release)}
          showFooter={false}
          disableStepIndicators
          transition="none"
          frame={false}
          width="100%"
        >
          {release.stages.map((s) => (
            <Step key={s.name} title={`${s.name} · ${STATE_LABEL[s.state]}`} />
          ))}
        </Stepper>
      )}
      {(a.changelog_entries?.length ?? 0) > 0 && (
        <section className="inbox-changelog" aria-label="Changelog entries">
          {a.changelog_entries?.map((entry, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: entries are fixed for an item's evidence
            <div key={i} className="inbox-entry">
              {renderInlineMarkdown(entry)}
            </div>
          ))}
        </section>
      )}
      {wave !== undefined && (a.screenshots?.length ?? 0) > 0 && (
        <div className="inbox-shots">
          {a.screenshots?.map((f) => (
            <a key={f} href={file(f) ?? undefined} target="_blank" rel="noopener noreferrer">
              <img
                src={file(f) ?? undefined}
                alt={`Staging smoke: ${baseName(f)}`}
                loading="lazy"
              />
            </a>
          ))}
        </div>
      )}
      {links.length > 0 && (
        <ul className="inbox-links">
          {links.map((l) => (
            <li key={l.href}>
              <a href={l.href} target="_blank" rel="noopener noreferrer">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
