// jest-dom's own `declare module "vitest"` resolves `vitest` from its shared
// install, which is volley-dash's vitest 2. Re-declare the matchers against
// this package's vitest so `toBeInTheDocument` etc. typecheck here.
import "vitest";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  // biome-ignore lint/suspicious/noExplicitAny: mirrors jest-dom's declaration
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
  // biome-ignore lint/suspicious/noExplicitAny: mirrors jest-dom's declaration
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}
