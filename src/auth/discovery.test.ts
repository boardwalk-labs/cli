import { describe, it, expect } from "vitest";
import { discoverOAuth } from "./discovery.js";
import type { FetchLike } from "./pkce.js";

function fakeFetch(status: number, body: unknown): FetchLike {
  return (input) => {
    // Assert the CLI hits the RFC 8414 well-known path on the issuer.
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : "";
    expect(url).toMatch(/\/\.well-known\/oauth-authorization-server$/);
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    );
  };
}

describe("discoverOAuth", () => {
  it("reads authorization_endpoint + token_endpoint (which may be on different hosts)", async () => {
    const result = await discoverOAuth(
      "https://api.boardwalk.sh/",
      fakeFetch(200, {
        authorization_endpoint: "https://app.boardwalk.sh/oauth/authorize",
        token_endpoint: "https://api.boardwalk.sh/oauth/token",
      }),
    );
    expect(result).toEqual({
      authorizationEndpoint: "https://app.boardwalk.sh/oauth/authorize",
      tokenEndpoint: "https://api.boardwalk.sh/oauth/token",
    });
  });

  it("throws on a non-2xx discovery response", async () => {
    await expect(discoverOAuth("https://api.x", fakeFetch(404, ""))).rejects.toThrow(
      /discovery failed \(404\)/,
    );
  });

  it("throws when the document is missing an endpoint", async () => {
    await expect(
      discoverOAuth(
        "https://api.x",
        fakeFetch(200, { token_endpoint: "https://api.x/oauth/token" }),
      ),
    ).rejects.toThrow(/missing an authorization_endpoint/);
  });

  it("throws on a non-JSON body", async () => {
    await expect(discoverOAuth("https://api.x", fakeFetch(200, "<html>nope"))).rejects.toThrow(
      /non-JSON/,
    );
  });
});
