import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignInBackdrop } from "../src/auth/SignInBackdrop";
import type { LineWavesProps } from "../src/rb/LineWaves/LineWaves";

const realMatchMedia = window.matchMedia;

/** `matchMedia` answering `true` for the listed queries. */
function mediaMatching(...queries: string[]) {
  window.matchMedia = ((query: string) => ({
    matches: queries.includes(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

/** A canvas that hands out a WebGL context (test setup's `getContext` returns null). */
function withWebGL() {
  const ctx = { getExtension: () => ({ loseContext: () => {} }) };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) =>
    kind === "webgl2" || kind === "webgl"
      ? ctx
      : null) as unknown as HTMLCanvasElement["getContext"]);
}

function FakeLineWaves(props: LineWavesProps) {
  return <div data-testid="line-waves" data-line-count={props.lineCount} />;
}

const loader = () => vi.fn(async () => ({ default: FakeLineWaves }));

afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
});

describe("SignInBackdrop", () => {
  it("without WebGL renders the plain gradient and never imports Line Waves", async () => {
    const load = loader();
    const { container } = render(<SignInBackdrop load={load} />);
    await act(async () => {});
    expect(container.querySelector(".signin-bg--plain")).toBeInTheDocument();
    expect(screen.queryByTestId("line-waves")).not.toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });

  it("under prefers-reduced-motion renders the plain gradient even with WebGL", async () => {
    withWebGL();
    mediaMatching("(prefers-reduced-motion: reduce)");
    const load = loader();
    const { container } = render(<SignInBackdrop load={load} />);
    await act(async () => {});
    expect(container.querySelector(".signin-bg--plain")).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });

  it("with WebGL lazy-loads and mounts Line Waves (14 lines)", async () => {
    withWebGL();
    const load = loader();
    render(<SignInBackdrop load={load} />);
    expect(await screen.findByTestId("line-waves")).toHaveAttribute("data-line-count", "14");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("at phone width draws fewer lines (8)", async () => {
    withWebGL();
    mediaMatching("(max-width: 699px)");
    render(<SignInBackdrop load={loader()} />);
    expect(await screen.findByTestId("line-waves")).toHaveAttribute("data-line-count", "8");
  });

  it("falls back to the plain gradient when Line Waves throws", async () => {
    withWebGL();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Broken = () => {
      throw new Error("WebGL context lost");
    };
    const { container } = render(<SignInBackdrop load={async () => ({ default: Broken })} />);
    await act(async () => {});
    expect(container.querySelector(".signin-bg--plain")).toBeInTheDocument();
  });
});
