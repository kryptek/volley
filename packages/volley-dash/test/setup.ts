/**
 * Vitest setup — extends `expect` with `@testing-library/jest-dom` matchers
 * (`toBeInTheDocument`, `toHaveTextContent`, etc.) and registers the
 * RTL afterEach cleanup so DOM state doesn't leak across tests.
 *
 * Bun's runtime installs a stub `localStorage` on the global before jsdom can
 * provide its own, which leaves the global with no `setItem` / `getItem` /
 * `clear` methods. Install an in-memory Storage shim on both `globalThis` and
 * `window` so persistence-flavored tests (e.g. notify settings) work.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
  };
}

function installStorage(name: "localStorage" | "sessionStorage"): void {
  const storage = createMemoryStorage();
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: storage,
  });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, name, {
      configurable: true,
      writable: true,
      value: storage,
    });
  }
}

installStorage("localStorage");
installStorage("sessionStorage");

afterEach(() => {
  cleanup();
});
