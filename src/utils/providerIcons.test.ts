import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { getProviderIcon, PROVIDER_ICONS } from "./providerIcons";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const officialCerebrasLogoSha256 =
  "5cd1e17dee4a2e135cbbe270776414e5e43babaea4715beb8c05f466c7a9c3f2";

describe("provider icons", () => {
  it("uses the exact standalone Cerebras mark from the official press kit", () => {
    const logoPath = path.join(repoRoot, "src/assets/icons/providers/cerebras.svg");
    const logo = fs.readFileSync(logoPath);
    const sha256 = createHash("sha256").update(logo).digest("hex");

    expect(sha256).toBe(officialCerebrasLogoSha256);
    expect(PROVIDER_ICONS.cerebras).toBeTruthy();
    expect(getProviderIcon("cerebras")).toBe(PROVIDER_ICONS.cerebras);
  });
});
