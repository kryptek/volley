/**
 * The background layer, ported from the prototype `backgrounds.tsx`: the
 * picked React Bits background (lazy, behind an error boundary) under a
 * `bg-dim` overlay whose opacity is the dim setting. A background that throws
 * (most often: no WebGL) shows a fallback message instead of taking the Desk
 * down; picking another one clears it. A chunk that fails to load (offline,
 * or the Desk was redeployed under an open tab) says so instead, with a Retry
 * that loads it again (not in the prototype, which had no deploys).
 */
import { Component, type ReactNode, Suspense, useMemo, useState } from "react";
import { BACKGROUNDS, type BackgroundDef, isChunkLoadError, loadable } from "./backgrounds";
import "../styles/look.css";

export const BG_FALLBACK = "This background needs WebGL, which this browser didn’t provide.";
export const BG_LOAD_FAILED = "Couldn’t load this background.";

type Failure = "render" | "load";

class Guard extends Component<
  { children: ReactNode; k: string; fallback: (failure: Failure) => ReactNode },
  { failure: Failure | null }
> {
  override state: { failure: Failure | null } = { failure: null };
  static getDerivedStateFromError(err: unknown) {
    return { failure: isChunkLoadError(err) ? "load" : "render" };
  }
  override componentDidUpdate(prev: { k: string }) {
    if (prev.k !== this.props.k && this.state.failure) this.setState({ failure: null });
  }
  override render() {
    return this.state.failure ? this.props.fallback(this.state.failure) : this.props.children;
  }
}

function Layer({ bg, dim, children }: { bg: string; dim: number; children: ReactNode }) {
  return (
    <div className="bg-layer" aria-hidden data-bg={bg}>
      {children}
      <div className="bg-dim" style={{ opacity: dim }} />
    </div>
  );
}

export function Background({
  which,
  dim,
  backgrounds = BACKGROUNDS,
}: {
  which: string;
  dim: number;
  /** The registry (tests swap in their own). */
  backgrounds?: readonly BackgroundDef[];
}) {
  const bg = backgrounds.find((b) => b.key === which) ?? backgrounds[0];
  const [attempt, setAttempt] = useState(0);
  // Resolved above the Suspense boundary, so a failed load stays failed until a new pick or Retry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt asks for a fresh load
  const C = useMemo(() => (bg?.C ? loadable(bg.C) : null), [bg?.C, attempt]);
  const key = bg?.key ?? "";
  if (!C) {
    return (
      <Layer bg={key} dim={dim}>
        <div className="bg-plain" />
      </Layer>
    );
  }
  return (
    <Guard
      k={`${key}:${attempt}`}
      fallback={(failure) =>
        failure === "render" ? (
          <Layer bg={key} dim={dim}>
            <div className="bg-fallback">{BG_FALLBACK}</div>
          </Layer>
        ) : (
          <>
            <Layer bg={key} dim={dim}>
              <div className="bg-plain" />
            </Layer>
            <div className="bg-load-failed" role="alert">
              {BG_LOAD_FAILED}
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </button>
            </div>
          </>
        )
      }
    >
      <Layer bg={key} dim={dim}>
        <Suspense fallback={null}>
          <C key={key} {...(bg?.p ?? {})} />
        </Suspense>
      </Layer>
    </Guard>
  );
}
