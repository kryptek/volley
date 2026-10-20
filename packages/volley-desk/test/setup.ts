/**
 * Vitest setup — jest-dom matchers, RTL cleanup, and the browser APIs jsdom
 * lacks but the canvas uses: `ResizeObserver` (Frame sizing) and pointer
 * capture (pan and title-bar drag). The React Bits components (D7) also want
 * `IntersectionObserver`, `matchMedia`, `Element.animate` (a stub
 * animation that never finishes) and a canvas `getContext`; jsdom's
 * `getContext` logs "not implemented", so it is replaced with one that
 * quietly returns null (no 2D / WebGL here, as in a browser without them).
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

class StubResizeObserver implements ResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.cb([{ target } as ResizeObserverEntry], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = StubResizeObserver;
}

// jsdom has no PointerEvent; without it fireEvent.pointer* dispatches a bare
// Event and drops clientX/clientY.
if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
  globalThis.PointerEvent = window.PointerEvent;
}

if (typeof Element !== "undefined" && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  class StubIntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds: readonly number[] = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  globalThis.IntersectionObserver =
    StubIntersectionObserver as unknown as typeof IntersectionObserver;
}

if (typeof window !== "undefined" && typeof window.matchMedia === "undefined") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (typeof Element !== "undefined" && !Element.prototype.animate) {
  Element.prototype.animate = function animate() {
    const anim = {
      playState: "running" as AnimationPlayState,
      onfinish: null,
      play() {
        anim.playState = "running";
      },
      pause() {
        anim.playState = "paused";
      },
      cancel() {},
      finish() {},
    };
    return anim as unknown as Animation;
  };
}

if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() => null) as HTMLCanvasElement["getContext"];
}

afterEach(() => {
  cleanup();
});
