/**
 * AWS Signature Version 4 signing for browser / Electron renderer.
 * Uses the Web Crypto API (SubtleCrypto) – no Node.js crypto needed.
 */

// ---------- low-level helpers ----------

const encoder = new TextEncoder();

async function sha256Hex(data: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", encoder.encode(data));
    return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

async function hmac(
    key: ArrayBuffer,
    message: string
): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        key,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
}

function toAmzDate(date: Date): { amzDate: string; dateStamp: string } {
    const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
    return {
        amzDate: iso, // 20260223T025800Z
        dateStamp: iso.slice(0, 8), // 20260223
    };
}

// ---------- signing key derivation ----------

async function getSigningKey(
    secretKey: string,
    dateStamp: string,
    region: string,
    service: string
): Promise<ArrayBuffer> {
    let key = await hmac(encoder.encode("AWS4" + secretKey).buffer as ArrayBuffer, dateStamp);
    key = await hmac(key, region);
    key = await hmac(key, service);
    key = await hmac(key, "aws4_request");
    return key;
}

// ---------- public API ----------

export interface AwsSigV4Options {
    method: string;
    url: string;
    region: string;
    service: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    body?: string;
    headers?: Record<string, string>;
}

export interface SignedRequest {
    url: string;
    headers: Record<string, string>;
    body?: string;
}

/**
 * Sign an HTTP request with AWS Signature Version 4.
 */
export async function signRequest(opts: AwsSigV4Options): Promise<SignedRequest> {
    const {
        method,
        url,
        region,
        service,
        accessKeyId,
        secretAccessKey,
        sessionToken,
        body = "",
    } = opts;

    const parsedUrl = new URL(url);
    const host = parsedUrl.host;
    const canonicalUri = parsedUrl.pathname || "/";
    const canonicalQuerystring = [...parsedUrl.searchParams]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");

    const now = new Date();
    const { amzDate, dateStamp } = toAmzDate(now);

    const payloadHash = await sha256Hex(body);

    // Build headers to sign
    const headersToSign: Record<string, string> = {
        host,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        ...(opts.headers || {}),
    };
    if (sessionToken) {
        headersToSign["x-amz-security-token"] = sessionToken;
    }

    const sortedHeaderKeys = Object.keys(headersToSign).sort();
    const signedHeaders = sortedHeaderKeys.join(";");
    const canonicalHeaders = sortedHeaderKeys
        .map((k) => `${k}:${headersToSign[k].trim()}\n`)
        .join("");

    const canonicalRequest = [
        method.toUpperCase(),
        canonicalUri,
        canonicalQuerystring,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        credentialScope,
        await sha256Hex(canonicalRequest),
    ].join("\n");

    const signingKey = await getSigningKey(secretAccessKey, dateStamp, region, service);
    const signatureBuffer = await hmac(signingKey, stringToSign);
    const signature = Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const finalHeaders: Record<string, string> = {
        ...headersToSign,
        Authorization: authorization,
    };
    // Content-Type is added by caller, not part of signed headers unless explicitly included
    delete finalHeaders.host; // Host header is set automatically by fetch

    return {
        url,
        headers: finalHeaders,
        body: body || undefined,
    };
}
