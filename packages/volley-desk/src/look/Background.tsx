/**
 * The background layer, ported from the prototype `backgrounds.tsx`: the
 * picked React Bits background (lazy, behind an error boundary) under a
 * `bg-dim` overlay whose opacity is the dim setting. A background that throws
 * (most often: no WebGL) shows a fallback message instead of taking the Desk
 * down; picking another one clears it.
 */
import { Component, type ReactNode, Suspense } from "react";
import { BACKGROUNDS, type BackgroundDef } from "./backgrounds";
import "../styles/look.css";

export const BG_FALLBACK = "This background needs WebGL, which this browser didn’t provide.";

class Guard extends Component<{ children: ReactNode; k: string }, { err: boolean }> {
  override state = { err: false };
  static getDerivedStateFromError() {
    return { err: true };
  }
  override componentDidUpdate(prev: { k: string }) {
    if (prev.k !== this.props.k && this.state.err) this.setState({ err: false });
  }
  override render() {
    return this.state.err ? <div className="bg-fallback">{BG_FALLBACK}</div> : this.props.children;
  }
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
  return (
    <div className="bg-layer" aria-hidden data-bg={bg?.key}>
      {bg?.C ? (
        <Guard k={bg.key}>
          <Suspense fallback={null}>
            <bg.C key={bg.key} {...(bg.p ?? {})} />
          </Suspense>
        </Guard>
      ) : (
        <div className="bg-plain" />
      )}
      <div className="bg-dim" style={{ opacity: dim }} />
    </div>
  );
}
