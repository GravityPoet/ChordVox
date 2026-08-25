import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { sha256NormalizedLegalText } = require("../../scripts/verify-mac-package");

describe("package legal text verification", () => {
  it("accepts the same legal text with Windows or Unix line endings", () => {
    expect(sha256NormalizedLegalText(Buffer.from("first\r\nsecond\r\n"))).toBe(
      sha256NormalizedLegalText(Buffer.from("first\nsecond\n"))
    );
  });

  it("still rejects substantive text differences", () => {
    expect(sha256NormalizedLegalText(Buffer.from("first\nsecond\n"))).not.toBe(
      sha256NormalizedLegalText(Buffer.from("first\nchanged\n"))
    );
  });
});
