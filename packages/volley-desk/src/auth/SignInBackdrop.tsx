/**
 * The sign-in's background, ported from the prototype `signin.tsx`: React Bits
 * Line Waves (lazy, its own chunk) under a vignette. It falls back to the
 * plain gradient without WebGL (D8's `hasWebGL`), under
 * `prefers-reduced-motion`, while the chunk loads, and when Line Waves throws
 * (the same guard as `look/Background.tsx`). Phone widths draw fewer lines.
 */
import {
  Component,
  type ComponentType,
  type ReactNode,
  Suspense,
  lazy,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useWebGL } from "../look/Background";

// A type-only reference: a static import of a background would pull its WebGL stack into the entry chunk.
type LineWavesProps = import("../rb/LineWaves/LineWaves").LineWavesProps;

export type LoadLineWaves = () => Promise<{ default: ComponentType<LineWavesProps> }>;

export const loadLineWaves: LoadLineWaves = () => import("../rb/LineWaves/LineWaves");

export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
export const PHONE = "(max-width: 699px)";

const WAVES: LineWavesProps = {
  color1: "#6ee7f9",
  color2: "#8b5cf6",
  color3: "#f472b6",
  lineCount: 14,
  glow: 1.2,
  brightness: 1.05,
  enableMouseInteraction: true,
};
const PHONE_LINES = 8;

/** Whether a media query matches, following changes. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia?.(query);
      mq?.addEventListener?.("change", onChange);
      return () => mq?.removeEventListener?.("change", onChange);
    },
    () => window.matchMedia?.(query).matches ?? false,
  );
}

class Guard extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const Plain = () => <div className="signin-bg signin-bg--plain" />;

function Waves({ load, phone }: { load: LoadLineWaves; phone: boolean }) {
  const C = useMemo(() => lazy(load), [load]);
  return (
    <Guard fallback={<Plain />}>
      <Suspense fallback={<Plain />}>
        <div className="signin-bg">
          <C {...WAVES} {...(phone ? { lineCount: PHONE_LINES } : {})} />
        </div>
      </Suspense>
    </Guard>
  );
}

export function SignInBackdrop({ load = loadLineWaves }: { load?: LoadLineWaves }) {
  const webgl = useWebGL();
  const reduced = useMedia(REDUCED_MOTION);
  const phone = useMedia(PHONE);
  return (
    <div className="signin-backdrop" aria-hidden>
      {webgl && !reduced ? <Waves load={load} phone={phone} /> : <Plain />}
      <div className="signin-vignette" />
    </div>
  );
}
