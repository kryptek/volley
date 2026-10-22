import { describe, expect, it } from "vitest";
import { maskEmail, normalizeEmail } from "../src/mask";

describe("maskEmail", () => {
  it("keeps the local part's first character and the domain", () => {
    expect(maskEmail("owner@example.com")).toBe("o•••@example.com");
  });

  it("a one-character local part still shows three bullets", () => {
    expect(maskEmail("o@example.com")).toBe("o•••@example.com");
  });

  it("an address with no @ masks whole", () => {
    expect(maskEmail("owner")).toBe("•••");
  });

  it("an empty address masks to bullets, never to nothing", () => {
    expect(maskEmail("")).toBe("•••");
    expect(maskEmail("@example.com")).toBe("•••@example.com");
  });

  it("only the last @ splits the domain", () => {
    expect(maskEmail("a@b@example.com")).toBe("a•••@example.com");
  });
});

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeEmail("  Owner@Example.COM ")).toBe("owner@example.com");
  });
});
