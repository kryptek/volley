/**
 * Vitest setup — extends `expect` with `@testing-library/jest-dom` matchers
 * (`toBeInTheDocument`, `toHaveTextContent`, etc.) and registers the
 * RTL afterEach cleanup so DOM state doesn't leak across tests.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
