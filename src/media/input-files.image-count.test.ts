import { describe, expect, it } from "vitest";
import { checkInputImageCount } from "./input-files.js";

describe("checkInputImageCount", () => {
  it("unset maxCount means unlimited", () => {
    expect(checkInputImageCount(10_000, {})).toBeNull();
    expect(checkInputImageCount(10_000, { maxCount: undefined })).toBeNull();
  });

  it("allows up to the cap and names the cap above it", () => {
    expect(checkInputImageCount(1, { maxCount: 1 })).toBeNull();
    expect(checkInputImageCount(2, { maxCount: 1 }, "x.maxCount")).toBe(
      "Too many input images: 2 (limit: 1, x.maxCount)",
    );
  });
});
