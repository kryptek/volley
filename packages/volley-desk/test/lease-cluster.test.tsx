import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LeasePools, Supervisor } from "../src/settings/Supervisor";
import type { LeasePoolPayload } from "../src/store/types";
import { NOW } from "./helpers/desk-msgs";

const at = new Date(NOW).toISOString();

const backendIt: LeasePoolPayload = {
  pool: "backend-it",
  capacity: 3,
  per_machine: 1,
  held: [
    { lease_id: "l-001", holder: "impl-3", host: "box-b", since: at, ttl_s: 1800 },
    { lease_id: "l-002", holder: "impl-1", host: "box-a", since: at, ttl_s: 1800 },
    { lease_id: "l-003", holder: "hand-run-1", host: null, since: at, ttl_s: 1800 },
  ],
  queue: [{ lease_id: "l-004", holder: "impl-4", host: "box-a", since: at }],
  reasons: ["queued l-004: 1/1 backend-it leases held on box-a (per machine)"],
};

describe("Supervisor › Lease pools", () => {
  it("groups each pool's holders by host, the unknown host last, with per_machine shown", () => {
    render(<LeasePools leases={{ "backend-it": backendIt }} />);
    const pool = within(screen.getByRole("article", { name: "backend-it" }));
    expect(pool.getByText("3/3 held · 1 per machine")).toBeInTheDocument();
    const hosts = pool.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(hosts).toEqual(["box-a", "box-b", "(unknown host)"]);
    expect(
      within(pool.getByRole("group", { name: "box-a" })).getByText("impl-1"),
    ).toBeInTheDocument();
    expect(
      within(pool.getByRole("group", { name: "(unknown host)" })).getByText("hand-run-1"),
    ).toBeInTheDocument();
    expect(pool.getByText("1 queued")).toBeInTheDocument();
    expect(
      pool.getByText("queued l-004: 1/1 backend-it leases held on box-a (per machine)"),
    ).toBeInTheDocument();
  });

  it("a pool without per_machine shows only its capacity; an older supervisor's holders are unknown-host", () => {
    const older: LeasePoolPayload = {
      pool: "build",
      capacity: 2,
      held: [{ lease_id: "b-1", holder: "impl-9", since: at, ttl_s: 600 }],
      queue: [],
      reasons: [],
    };
    render(<LeasePools leases={{ build: older }} />);
    const pool = within(screen.getByRole("article", { name: "build" }));
    expect(pool.getByText("1/2 held")).toBeInTheDocument();
    expect(pool.getByRole("group", { name: "(unknown host)" })).toBeInTheDocument();
  });

  it("shows each host's held count against the cap in force there (override, else per_machine)", () => {
    const jsSuite: LeasePoolPayload = {
      pool: "js-suite",
      capacity: 4,
      per_machine: 2,
      per_machine_overrides: { "box-a": 3, laptop: 1, "box-c": 0 },
      held: [
        { lease_id: "j-1", holder: "impl-1", host: "box-a", since: at, ttl_s: 600 },
        { lease_id: "j-2", holder: "impl-2", host: "box-a", since: at, ttl_s: 600 },
        { lease_id: "j-3", holder: "impl-3", host: "laptop", since: at, ttl_s: 600 },
        { lease_id: "j-4", holder: "impl-4", host: "box-b", since: at, ttl_s: 600 },
        { lease_id: "j-5", holder: "hand-1", host: null, since: at, ttl_s: 600 },
      ],
      queue: [],
      reasons: [],
    };
    render(<LeasePools leases={{ "js-suite": jsSuite }} />);
    const pool = within(screen.getByRole("article", { name: "js-suite" }));
    // An overridden machine shows even before it holds anything.
    const hosts = pool.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(hosts).toEqual(["box-a", "box-b", "box-c", "laptop", "(unknown host)"]);
    const count = (host: string) =>
      pool.getByRole("group", { name: host }).querySelector(".lease-host-count")?.textContent;
    expect(count("box-a")).toBe("2/3");
    expect(count("box-b")).toBe("1/2");
    expect(count("box-c")).toBe("0/0");
    expect(count("laptop")).toBe("1/1");
    // No cap applies to a holder volleyd did not place.
    expect(count("(unknown host)")).toBe("1");
  });

  it("a host with no cap in force (no per_machine, no override) shows only its held count", () => {
    const pool: LeasePoolPayload = {
      pool: "build",
      capacity: 3,
      per_machine_overrides: { laptop: 1 },
      held: [{ lease_id: "b-1", holder: "impl-1", host: "box-a", since: at, ttl_s: 600 }],
      queue: [],
      reasons: [],
    };
    render(<LeasePools leases={{ build: pool }} />);
    const card = within(screen.getByRole("article", { name: "build" }));
    const count = (host: string) =>
      card.getByRole("group", { name: host }).querySelector(".lease-host-count")?.textContent;
    expect(count("box-a")).toBe("1");
    expect(count("laptop")).toBe("0/1");
  });

  it("Settings › Supervisor › Lease pools shows the card above the pools' capacity rows", () => {
    const config = {
      version: 1,
      updated_at: at,
      updated_by: "owner",
      lease_pools: { "backend-it": { capacity: 3, ttl_s: 1800, match: ["make it"] } },
    };
    const { container, rerender } = render(
      <Supervisor
        config={config}
        transport={null}
        leases={{ "backend-it": backendIt }}
        group="leases"
      />,
    );
    const card = screen.getByRole("region", { name: "Lease pools" });
    const rowEl = screen.getByRole("slider", { name: "backend-it pool capacity" });
    expect(card.compareDocumentPosition(rowEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll(".lease-pools")).toHaveLength(1);
    rerender(
      <Supervisor
        config={config}
        transport={null}
        leases={{ "backend-it": backendIt }}
        group="admission"
      />,
    );
    expect(screen.queryByRole("region", { name: "Lease pools" })).toBeNull();
  });
});
