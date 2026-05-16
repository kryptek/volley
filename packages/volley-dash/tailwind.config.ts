import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * Tailwind theme — every OKLCH design token from the design handoff
 * (`design_handoff_volley_dashboard/styles.css`) is exposed here as a
 * Tailwind utility namespace, backed by the matching CSS custom property
 * declared on `:root` in `src/styles/globals.css`. Utility names mirror the
 * source token names so consumers can write `bg-bg`, `text-fg-3`,
 * `border-line`, `text-st-working`, `text-c-pr`, etc.
 */
const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── Surfaces (warm-neutral OKLCH, never pure black) ──────────────
        bg: "var(--bg)",
        "bg-2": "var(--bg-2)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        "surface-hi": "var(--surface-hi)",
        line: "var(--line)",
        "line-hi": "var(--line-hi)",

        // ── Text ─────────────────────────────────────────────────────────
        fg: "var(--fg)",
        "fg-2": "var(--fg-2)",
        "fg-3": "var(--fg-3)",
        "fg-4": "var(--fg-4)",

        // ── Accent (phosphor cyan default) ───────────────────────────────
        accent: {
          DEFAULT: "var(--accent)",
          dim: "var(--accent-dim)",
          glow: "var(--accent-glow)",
        },

        // ── Status (seven lifecycle states) ──────────────────────────────
        st: {
          spawning: "var(--st-spawning)",
          registered: "var(--st-registered)",
          working: "var(--st-working)",
          done: "var(--st-done)",
          blocked: "var(--st-blocked)",
          failed: "var(--st-failed)",
          reaped: "var(--st-reaped)",
        },

        // ── Channel colors (live-feed event tags) ────────────────────────
        c: {
          st: "var(--c-st)",
          pr: "var(--c-pr)",
          mb: "var(--c-mb)",
          rs: "var(--c-rs)",
          sy: "var(--c-sy)",
        },
      },
      fontFamily: {
        sans: ["IBM Plex Sans", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      borderRadius: {
        DEFAULT: "var(--radius)",
        lg: "var(--radius-lg)",
      },
    },
  },
  plugins: [animate],
};

export default config;
