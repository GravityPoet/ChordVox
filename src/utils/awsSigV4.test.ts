import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { signRequest } from "./awsSigV4";

describe("awsSigV4 signRequest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Fix system time to 2026-02-23T02:58:00Z
    vi.setSystemTime(new Date("2026-02-23T02:58:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("successfully signs a GET request with query params", async () => {
    const opts = {
      method: "GET",
      url: "https://translate-speech.cn-north-1.amazonaws.com.cn/v1/speech?Action=Translate&Version=2020-09-10",
      region: "cn-north-1",
      service: "translate",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    };

    const signed = await signRequest(opts);

    expect(signed.url).toBe(opts.url);
    expect(signed.headers["x-amz-date"]).toBe("20260223T025800Z");
    expect(signed.headers["x-amz-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" // empty body hash
    );
    expect(signed.headers.Authorization).toContain("AWS4-HMAC-SHA256");
    expect(signed.headers.Authorization).toContain(
      "Credential=AKIAIOSFODNN7EXAMPLE/20260223/cn-north-1/translate/aws4_request"
    );
    expect(signed.headers.Authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date"
    );
    expect(signed.headers.Authorization).toContain("Signature=");
  });

  it("signs a POST request with body and custom headers", async () => {
    const opts = {
      method: "POST",
      url: "https://sts.amazonaws.com/",
      region: "us-east-1",
      service: "sts",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      sessionToken: "session-token-xyz",
      body: "Action=GetCallerIdentity&Version=2011-06-15",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
    };

    const signed = await signRequest(opts);

    expect(signed.body).toBe(opts.body);
    expect(signed.headers["x-amz-date"]).toBe("20260223T025800Z");
    expect(signed.headers["x-amz-security-token"]).toBe("session-token-xyz");
    expect(signed.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(signed.headers.Authorization).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token"
    );
  });
});
