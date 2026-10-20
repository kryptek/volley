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

  it("Settings › Supervisor shows the card above the config rows when pools exist", () => {
    render(<Supervisor config={null} transport={null} leases={{ "backend-it": backendIt }} />);
    expect(screen.getByRole("heading", { name: "Lease pools" })).toBeInTheDocument();
  });
});
