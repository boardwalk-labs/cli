import { describe, it, expect } from "vitest";
import { loadConfig, trimTrailingSlash } from "./config.js";

describe("loadConfig", () => {
  it("applies defaults when no env is set", () => {
    const c = loadConfig({});
    expect(c.apiBaseUrl).toBe("https://api.boardwalk.sh");
    // Boardwalk self-hosts its OAuth server, so the issuer is the API host (discovery lives there).
    expect(c.issuerUrl).toBe("https://api.boardwalk.sh");
    // The first-party CLI client id ships as a default (no per-user OAuth-app setup).
    expect(c.oauthClientId).toBe("boardwalk-cli");
    expect(c.loopbackPort).toBe(53682);
    expect(c.configDir.length).toBeGreaterThan(0);
  });

  it("derives the API base from BOARDWALK_API_DOMAIN (the self-host knob)", () => {
    expect(loadConfig({ BOARDWALK_API_DOMAIN: "api.acme-corp.com" }).apiBaseUrl).toBe(
      "https://api.acme-corp.com",
    );
    // tolerant of an accidental scheme / trailing slash
    expect(loadConfig({ BOARDWALK_API_DOMAIN: "https://api.acme.com/" }).apiBaseUrl).toBe(
      "https://api.acme.com",
    );
  });

  it("prefers a full BOARDWALK_API_URL over the domain (local/non-standard ports)", () => {
    const c = loadConfig({
      BOARDWALK_API_URL: "http://localhost:8080/",
      BOARDWALK_API_DOMAIN: "api.ignored.com",
    });
    expect(c.apiBaseUrl).toBe("http://localhost:8080");
  });

  it("reads the issuer override and strips trailing slashes", () => {
    expect(loadConfig({ BOARDWALK_ISSUER_URL: "https://auth.dev.example//" }).issuerUrl).toBe(
      "https://auth.dev.example",
    );
  });

  it("reads the OAuth client id and loopback port", () => {
    const c = loadConfig({ BOARDWALK_OAUTH_CLIENT_ID: "client_abc", BOARDWALK_OAUTH_PORT: "9000" });
    expect(c.oauthClientId).toBe("client_abc");
    expect(c.loopbackPort).toBe(9000);
  });

  it("falls back to the default port for an invalid BOARDWALK_OAUTH_PORT", () => {
    expect(loadConfig({ BOARDWALK_OAUTH_PORT: "notaport" }).loopbackPort).toBe(53682);
    expect(loadConfig({ BOARDWALK_OAUTH_PORT: "99999" }).loopbackPort).toBe(53682);
  });

  it("treats a blank client id override as unset (falls back to the built-in CLI client id)", () => {
    expect(loadConfig({ BOARDWALK_OAUTH_CLIENT_ID: "   " }).oauthClientId).toBe("boardwalk-cli");
  });

  it("honors BOARDWALK_CONFIG_DIR", () => {
    expect(loadConfig({ BOARDWALK_CONFIG_DIR: "/tmp/bw" }).configDir).toBe("/tmp/bw");
  });
});

describe("trimTrailingSlash", () => {
  it("removes one or more trailing slashes", () => {
    expect(trimTrailingSlash("https://x.y///")).toBe("https://x.y");
    expect(trimTrailingSlash("https://x.y")).toBe("https://x.y");
  });
});
