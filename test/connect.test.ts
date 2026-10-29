import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gatewayFetch, parseConnectTo } from "../src/archestra/connect";

describe("parseConnectTo", () => {
  it("accepts host:port and a bracketed IPv6 address", () => {
    expect(parseConnectTo("127.0.0.1:18443")).toEqual({ host: "127.0.0.1", port: 18443 });
    expect(parseConnectTo(" tunnel.local:443 ")).toEqual({ host: "tunnel.local", port: 443 });
    expect(parseConnectTo("[::1]:8443")).toEqual({ host: "::1", port: 8443 });
  });

  it("refuses anything else", () => {
    for (const raw of ["", "127.0.0.1", "127.0.0.1:0", "127.0.0.1:65536", "http://127.0.0.1:1", "a b:1", "::1:1"]) {
      expect(parseConnectTo(raw), raw).toBeNull();
    }
  });
});

let hasOpenssl = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  hasOpenssl = false;
}

describe.skipIf(!hasOpenssl)("gatewayFetch", () => {
  let dir: string;
  let cert: string;
  let server: https.Server;
  let port: number;
  const seen: Array<{ servername: string | undefined; host: string | undefined; path: string | undefined }> = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "connect-test-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
      "-subj", "/CN=gateway.test", "-addext", "subjectAltName=DNS:gateway.test",
    ], { stdio: "ignore" });
    cert = readFileSync(join(dir, "cert.pem"), "utf8");
    server = https.createServer({ key: readFileSync(join(dir, "key.pem")), cert }, (request, response) => {
      seen.push({ servername: (request.socket as TLSSocket).servername, host: request.headers.host, path: request.url });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("dials the gateway host at the local address, with the gateway's name for TLS and Host", async () => {
    const fetchImpl = gatewayFetch("https://gateway.test/v1/mcp/code-review", { host: "127.0.0.1", port }, { ca: cert });
    const response = await fetchImpl("https://gateway.test/api/github-actions/token", { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen.at(-1)).toEqual({ servername: "gateway.test", host: "gateway.test", path: "/api/github-actions/token" });
  });

  it("leaves every other host on its own address and name", async () => {
    const fetchImpl = gatewayFetch("https://gateway.test/v1/mcp/code-review", { host: "127.0.0.1", port }, { ca: cert });
    // Dialed directly, the server's certificate does not name 127.0.0.1: the gateway route was not applied.
    await expect(fetchImpl(`https://127.0.0.1:${port}/`)).rejects.toThrow(/fetch failed/);
  });
});
