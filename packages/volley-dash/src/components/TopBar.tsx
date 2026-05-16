/**
 * TopBar — 48px fixed-height app header. Brand mark + wordmark + version
 * on the left, namespace tabs next, then a flex spacer, at-a-glance stats
 * (working count + stuck count = blocked + failed) hidden below 1080px,
 * broker LED + URL (URL hidden below 1180px), then the search input.
 *
 * Search is a 200px input with `/` keystroke focus (handled here at the
 * window level when no other input is focused). Substring match across
 * agent id / namespace / capability tags / parent id / progress message
 * is performed upstream by AgentGrid; this component just owns the query
 * string + clear button.
 *
 * The namespace tabs use shadcn's Radix-backed `<Tabs />` primitive with
 * per-trigger className overrides so the segmented-control look from
 * globals.css (`.vd-ns-tabs` / `.vd-ns-tab`) still applies.
 */
import { Search, X } from "lucide-react";
import { type ChangeEvent, type KeyboardEvent, useEffect, useRef } from "react";
import { Input } from "./ui/input";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

const VOLLEY_VERSION = "v0.1.0";

export interface TopBarProps {
  namespaces?: string[] | undefined;
  ns?: string | "all" | undefined;
  setNs?: ((next: string | "all") => void) | undefined;
  agentCounts?: Record<string, number> | undefined;
  workingCount?: number | undefined;
  stuckCount?: number | undefined;
  brokerStatus?: "connecting" | "connected" | "disconnected" | undefined;
  brokerUrl?: string | undefined;
  query?: string | undefined;
  setQuery?: ((next: string) => void) | undefined;
}

export function TopBar({
  namespaces = [],
  ns = "all",
  setNs = () => {},
  agentCounts = {},
  workingCount = 0,
  stuckCount = 0,
  brokerStatus = "connected",
  brokerUrl = "mqtt://broker.local:9001",
  query = "",
  setQuery = () => {},
}: TopBarProps = {}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // `/` from anywhere focuses search (unless already typing in an input).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== "/") return;
      const target = document.activeElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      e.currentTarget.blur();
      setQuery("");
    }
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setQuery(e.target.value);
  };

  const ledColor = brokerStatus === "connected" ? "var(--st-working)" : "var(--st-failed)";
  const totalCount = agentCounts.all ?? 0;

  return (
    <header data-testid="top-bar" className="vd-topbar">
      <div className="vd-brand">
        <div data-testid="brand-mark" className="vd-brand-mark" aria-hidden="true" />
        <span>volley</span>
        <span className="vd-brand-ver">{VOLLEY_VERSION}</span>
      </div>
      <div className="vd-divider" />
      <Tabs value={ns} onValueChange={(v) => setNs(v)}>
        <TabsList data-testid="namespace-tabs" className="vd-ns-tabs" aria-label="Namespace">
          <TabsTrigger value="all" className="vd-ns-tab">
            <span>all</span>
            <span className="vd-count">{totalCount}</span>
          </TabsTrigger>
          {namespaces.map((n) => (
            <TabsTrigger key={n} value={n} className="vd-ns-tab">
              <span>{n}</span>
              <span className="vd-count">{agentCounts[n] ?? 0}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="vd-grow" />
      <div className="vd-stat vd-stat-extra">
        <b>{workingCount}</b> working
      </div>
      <div className="vd-stat vd-stat-extra" style={{ color: "var(--st-failed)" }}>
        <b style={{ color: "inherit" }}>{stuckCount}</b> stuck
      </div>
      <div className="vd-divider" />
      <div className="vd-stat">
        <span
          className="vd-led"
          style={{ background: ledColor, boxShadow: `0 0 6px ${ledColor}` }}
          aria-label={`broker ${brokerStatus}`}
        />
        <span className="vd-broker-url">{brokerUrl}</span>
      </div>
      <div className="vd-search">
        <Search className="vd-icon" aria-hidden="true" />
        <Input
          ref={inputRef}
          data-testid="search-input"
          type="search"
          placeholder="filter agents, tags…"
          value={query}
          onChange={onChange}
          onKeyDown={onSearchKey}
          aria-label="Search agents"
          className="vd-search-input"
        />
        {query.length > 0 ? (
          <button
            type="button"
            className="vd-search-clear"
            onClick={() => setQuery("")}
            aria-label="Clear search"
          >
            <X className="vd-icon" />
          </button>
        ) : (
          <kbd>/</kbd>
        )}
      </div>
    </header>
  );
}
