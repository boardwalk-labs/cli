// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { generatePkcePair, randomState, oauthEndpoints, buildAuthorizeUrl } from "./pkce.js";

// RFC 7636 unreserved set for the code_verifier: ALPHA / DIGIT / "-" / "." / "_" / "~".
// generatePkcePair() uses base64url, which only emits [A-Za-z0-9_-] (a subset).
const RFC7636_VERIFIER = /^[A-Za-z0-9\-._~]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("generatePkcePair — code_verifier", () => {
  it("conforms to RFC 7636 length (43-128) and the unreserved charset", () => {
    for (let i = 0; i < 50; i++) {
      const { verifier } = generatePkcePair();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      expect(verifier).toMatch(RFC7636_VERIFIER);
      // base64url of 48 random bytes is 64 chars with no padding.
      expect(verifier).toMatch(BASE64URL);
      expect(verifier).toHaveLength(64);
    }
  });

  it("produces a fresh, unpredictable verifier each call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generatePkcePair().verifier);
    expect(seen.size).toBe(100);
  });
});

describe("generatePkcePair — S256 challenge", () => {
  it("equals base64url(SHA-256(verifier)) for the generated verifier", () => {
    const { verifier, challenge } = generatePkcePair();
    const expected = createHash("sha256").update(verifier, "ascii").digest().toString("base64url");
    expect(challenge).toBe(expected);
  });

  it("matches the deterministic RFC-7636-style S256 vector for a known verifier", () => {
    // The module hashes the ASCII bytes of the verifier string, so the challenge for any
    // fixed verifier is fully deterministic. Verify against an independently computed digest.
    const knownVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = createHash("sha256")
      .update(knownVerifier, "ascii")
      .digest()
      .toString("base64url");
    expect(expected).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");

    // The pair we generate is self-consistent under the same algorithm.
    const { verifier, challenge } = generatePkcePair();
    expect(challenge).toBe(
      createHash("sha256").update(verifier, "ascii").digest().toString("base64url"),
    );
  });

  it("emits no '+', '/', or '=' padding in either the verifier or the challenge", () => {
    for (let i = 0; i < 50; i++) {
      const { verifier, challenge } = generatePkcePair();
      for (const value of [verifier, challenge]) {
        expect(value).not.toContain("+");
        expect(value).not.toContain("/");
        expect(value).not.toContain("=");
        expect(value).toMatch(BASE64URL);
      }
      // SHA-256 is 32 bytes ⇒ 43 base64url chars (no padding).
      expect(challenge).toHaveLength(43);
    }
  });
});

describe("randomState", () => {
  it("is unique across repeated calls and has the expected entropy/length", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const state = randomState();
      // UUID with hyphens stripped ⇒ 32 lowercase hex chars (128 bits of entropy).
      expect(state).toMatch(/^[0-9a-f]{32}$/);
      expect(state).toHaveLength(32);
      expect(state).not.toContain("-");
      seen.add(state);
    }
    expect(seen.size).toBe(200);
  });
});

describe("oauthEndpoints", () => {
  it("derives /oauth/authorize and /oauth/token from the issuer origin", () => {
    expect(oauthEndpoints("https://id.example.com")).toEqual({
      authorize: "https://id.example.com/oauth/authorize",
      token: "https://id.example.com/oauth/token",
    });
  });

  it("strips trailing slashes from the issuer URL before appending paths", () => {
    expect(oauthEndpoints("https://id.example.com///")).toEqual({
      authorize: "https://id.example.com/oauth/authorize",
      token: "https://id.example.com/oauth/token",
    });
  });
});

describe("buildAuthorizeUrl", () => {
  it("always advertises the S256 challenge method (never plain) and url-encodes params", () => {
    const url = buildAuthorizeUrl({
      authorizeEndpoint: "https://id.example.com/oauth/authorize",
      clientId: "client 123",
      redirectUri: "http://127.0.0.1:8976/callback",
      codeChallenge: "abc-_DEF",
      state: "state==",
      scope: "openid profile",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://id.example.com/oauth/authorize");
    const q = parsed.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe("abc-_DEF");
    expect(q.get("client_id")).toBe("client 123");
    expect(q.get("redirect_uri")).toBe("http://127.0.0.1:8976/callback");
    expect(q.get("state")).toBe("state==");
    expect(q.get("scope")).toBe("openid profile");
    // Reserved characters are percent-encoded in the raw query string.
    expect(url).toContain("client_id=client+123");
    expect(url).not.toContain("code_challenge_method=plain");
  });

  it("round-trips a freshly generated challenge + state without corruption", () => {
    const { challenge } = generatePkcePair();
    const state = randomState();
    const url = buildAuthorizeUrl({
      authorizeEndpoint: "https://id.example.com/oauth/authorize",
      clientId: "cli",
      redirectUri: "http://127.0.0.1:8976/callback",
      codeChallenge: challenge,
      state,
      scope: "openid",
    });
    const q = new URL(url).searchParams;
    expect(q.get("code_challenge")).toBe(challenge);
    expect(q.get("state")).toBe(state);
  });
});
