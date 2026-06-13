// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import {
  generatePkcePair,
  randomState,
  oauthEndpoints,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  isExpired,
  type FetchLike,
} from "./pkce.js";

describe("generatePkcePair", () => {
  it("produces a url-safe verifier and an S256 challenge", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier).not.toBe(challenge);
  });

  it("is unique per call", () => {
    expect(generatePkcePair().verifier).not.toBe(generatePkcePair().verifier);
  });
});

describe("randomState", () => {
  it("is 32 hex chars (UUID without hyphens)", () => {
    expect(randomState()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("oauthEndpoints", () => {
  it("derives /oauth/authorize and /oauth/token from the issuer", () => {
    expect(oauthEndpoints("https://auth.boardwalk.sh/")).toEqual({
      authorize: "https://auth.boardwalk.sh/oauth/authorize",
      token: "https://auth.boardwalk.sh/oauth/token",
    });
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes the PKCE + OAuth params", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizeEndpoint: "https://auth.example/oauth/authorize",
        clientId: "client_1",
        redirectUri: "http://127.0.0.1:53682/callback",
        codeChallenge: "chal",
        state: "st",
        scope: "openid profile email",
      }),
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client_1");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:53682/callback");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("scope")).toBe("openid profile email");
  });
});

function fakeFetch(status: number, body: unknown): FetchLike {
  return () =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    );
}

describe("exchangeCode", () => {
  it("parses a token response and computes absolute expiry", async () => {
    const res = await exchangeCode({
      tokenEndpoint: "https://auth.example/oauth/token",
      clientId: "c",
      code: "auth-code",
      codeVerifier: "v",
      redirectUri: "http://127.0.0.1:53682/callback",
      fetchImpl: fakeFetch(200, {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        scope: "openid",
      }),
      now: 1_000_000,
    });
    expect(res).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1_000_000 + 3600 * 1000,
      scope: "openid",
    });
  });

  it("sets expiresAt null when expires_in is absent", async () => {
    const res = await exchangeCode({
      tokenEndpoint: "https://auth.example/oauth/token",
      clientId: "c",
      code: "x",
      codeVerifier: "v",
      redirectUri: "r",
      fetchImpl: fakeFetch(200, { access_token: "at" }),
    });
    expect(res.expiresAt).toBeNull();
    expect(res.refreshToken).toBeNull();
  });

  it("throws on an OAuth error response", async () => {
    await expect(
      exchangeCode({
        tokenEndpoint: "https://auth.example/oauth/token",
        clientId: "c",
        code: "x",
        codeVerifier: "v",
        redirectUri: "r",
        fetchImpl: fakeFetch(400, { error: "invalid_grant" }),
      }),
    ).rejects.toThrow(/Token request failed \(400\)/);
  });

  it("throws when access_token is missing", async () => {
    await expect(
      exchangeCode({
        tokenEndpoint: "https://auth.example/oauth/token",
        clientId: "c",
        code: "x",
        codeVerifier: "v",
        redirectUri: "r",
        fetchImpl: fakeFetch(200, { token_type: "Bearer" }),
      }),
    ).rejects.toThrow(/missing an access_token/);
  });
});

describe("refreshAccessToken", () => {
  it("exchanges a refresh token", async () => {
    const res = await refreshAccessToken({
      tokenEndpoint: "https://auth.example/oauth/token",
      clientId: "c",
      refreshToken: "old-rt",
      fetchImpl: fakeFetch(200, {
        access_token: "new-at",
        refresh_token: "new-rt",
        expires_in: 60,
      }),
      now: 0,
    });
    expect(res.accessToken).toBe("new-at");
    expect(res.refreshToken).toBe("new-rt");
    expect(res.expiresAt).toBe(60_000);
  });
});

describe("isExpired", () => {
  it("is false for a null expiry (non-expiring)", () => {
    expect(isExpired(null)).toBe(false);
  });
  it("is true within the 30s grace window", () => {
    expect(isExpired(100_000, 100_000 - 10_000)).toBe(true); // 10s left < 30s grace
  });
  it("is false when comfortably in the future", () => {
    expect(isExpired(100_000, 0)).toBe(false);
  });
});
