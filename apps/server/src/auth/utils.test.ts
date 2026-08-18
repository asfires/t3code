import { describe, expect, it } from "vite-plus/test";

import {
  base64UrlEncode,
  decodeDevelopmentSessionCookieName,
  deriveAuthClientMetadata,
  isRemoteReachableHost,
  planStaleDevelopmentSessionCookieSweep,
  resolveSessionCookieName,
} from "./utils.ts";

describe("deriveAuthClientMetadata", () => {
  it("labels Electron user agents as Electron instead of Chrome", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) t3code/0.0.15 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:127.0.0.1",
        },
      } as never,
    });

    expect(metadata).toMatchObject({
      browser: "Electron",
      deviceType: "desktop",
      ipAddress: "127.0.0.1",
      os: "macOS",
    });
  });

  it("applies client-presented display identity without replacing transport metadata", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:192.168.213.72",
        },
      } as never,
      presented: {
        label: "T3 Code Mobile",
        deviceType: "mobile",
        os: "iOS",
      },
    });

    expect(metadata).toMatchObject({
      label: "T3 Code Mobile",
      browser: "Electron",
      deviceType: "mobile",
      ipAddress: "192.168.213.72",
      os: "iOS",
    });
    expect(metadata.userAgent).toContain("Electron/36.3.2");
  });
});

describe("session cookie isolation", () => {
  it("isolates loopback web servers by port and encoded server state", () => {
    const firstStateDir = "/tmp/t3-agent-one";
    const secondStateDir = "/tmp/t3-agent-two";
    const first = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: firstStateDir,
      development: true,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: secondStateDir,
      development: true,
    });

    expect(first).toBe(`t3_session_5775_${base64UrlEncode(firstStateDir)}`);
    expect(second).toBe(`t3_session_5775_${base64UrlEncode(secondStateDir)}`);
    expect(decodeDevelopmentSessionCookieName(first)).toEqual({
      port: 5775,
      stateDir: firstStateDir,
    });
    expect(decodeDevelopmentSessionCookieName(second)).toEqual({
      port: 5775,
      stateDir: secondStateDir,
    });
    expect(first).not.toBe(second);
  });

  it("keeps the hosted web cookie stable across server instances", () => {
    expect(
      resolveSessionCookieName({
        mode: "web",
        port: 8080,
        host: "0.0.0.0",
        instanceKey: "/srv/release-a",
        development: false,
      }),
    ).toBe("t3_session");
    expect(
      resolveSessionCookieName({
        mode: "web",
        port: 9090,
        host: "app.example.com",
        instanceKey: "/srv/release-b",
        development: false,
      }),
    ).toBe("t3_session");
  });

  it("retains desktop port scoping", () => {
    expect(
      resolveSessionCookieName({
        mode: "desktop",
        port: 3773,
        host: "127.0.0.1",
        instanceKey: "/tmp/desktop",
        development: true,
      }),
    ).toBe("t3_session_3773");
  });

  it("isolates development servers even when they bind a wildcard host", () => {
    const stateDir = "/tmp/t3-wildcard-dev";
    expect(
      resolveSessionCookieName({
        mode: "web",
        port: 5775,
        host: "0.0.0.0",
        instanceKey: stateDir,
        development: true,
      }),
    ).toBe(`t3_session_5775_${base64UrlEncode(stateDir)}`);
  });

  it("classifies loopback aliases separately from remotely reachable hosts", () => {
    expect(isRemoteReachableHost(undefined)).toBe(false);
    expect(isRemoteReachableHost("localhost")).toBe(false);
    expect(isRemoteReachableHost("127.12.0.1")).toBe(false);
    expect(isRemoteReachableHost("[::1]")).toBe(false);
    expect(isRemoteReachableHost("0.0.0.0")).toBe(true);
    expect(isRemoteReachableHost("192.168.1.50")).toBe(true);
  });
});

describe("development session cookie decoding", () => {
  it("classifies encoded state directories, legacy hashes, and unrelated names", () => {
    const stateDir = "/tmp/t3-agent-state";

    expect(
      decodeDevelopmentSessionCookieName(`t3_session_5775_${base64UrlEncode(stateDir)}`),
    ).toEqual({ port: 5775, stateDir });
    expect(decodeDevelopmentSessionCookieName("t3_session_5775_0123456789ab")).toEqual({
      port: 5775,
      legacyHash: "0123456789ab",
    });
    expect(decodeDevelopmentSessionCookieName("t3_session")).toBeNull();
    expect(decodeDevelopmentSessionCookieName("t3_session_5775")).toBeNull();
    expect(
      decodeDevelopmentSessionCookieName(`t3_session_5775_${base64UrlEncode("relative/state")}`),
    ).toBeNull();
    expect(decodeDevelopmentSessionCookieName("other_5775_0123456789ab")).toBeNull();
  });
});

describe("stale development session cookie sweep", () => {
  it("expires only dead encoded siblings and same-port legacy cookies", () => {
    const ownCookieName = `t3_session_5775_${base64UrlEncode("/tmp/own")}`;
    const liveSibling = `t3_session_5776_${base64UrlEncode("/tmp/live")}`;
    const staleSibling = `t3_session_5777_${base64UrlEncode("/tmp/stale")}`;
    const samePortLegacy = "t3_session_5775_0123456789ab";
    const otherPortLegacy = "t3_session_5778_abcdef012345";

    expect(
      planStaleDevelopmentSessionCookieSweep({
        ownCookieName,
        ownPort: 5775,
        requestCookieNames: [
          ownCookieName,
          liveSibling,
          staleSibling,
          samePortLegacy,
          otherPortLegacy,
          "t3_session",
          "t3_session_3773",
        ],
        stateDirExists: (stateDir) => stateDir === "/tmp/live",
      }),
    ).toEqual([staleSibling, samePortLegacy]);
  });
});
