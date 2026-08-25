import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

describe("transcriptionCrypto", () => {
  beforeEach(() => {
    vi.resetModules();
    delete require.cache[require.resolve("./transcriptionCrypto")];
    delete require.cache[require.resolve("./secureSecrets")];
  });

  it("does not create or cache a new data key when decrypting existing ciphertext without a stored key", () => {
    const secureSecrets = require("./secureSecrets");
    vi.spyOn(secureSecrets, "loadSecretSync").mockReturnValue("");
    const saveSecrets = vi.spyOn(secureSecrets, "saveSecretsSync").mockImplementation(() => true);

    const { decryptTranscriptionText } = require("./transcriptionCrypto");
    const encryptedEmptyPayload = `encv1:${Buffer.alloc(29).toString("base64")}`;

    expect(decryptTranscriptionText(encryptedEmptyPayload)).toBe("");
    expect(saveSecrets).not.toHaveBeenCalled();
  });
});
