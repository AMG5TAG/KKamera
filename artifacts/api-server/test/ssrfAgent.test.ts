import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { SafeHttpAgent, SafeHttpsAgent, connectTargetViolation, safeLookup } from "../src/lib/ssrf.ts";

// These prove the connect-time guard refuses private IP literals — the case a
// WebDAV `302 Location: http://169.254.169.254/` redirect hits, where the
// agent's DNS `lookup` hook never runs. Everything is refused before any socket
// is opened, so no network access is needed (a real connect would surface as
// ECONNREFUSED/ETIMEDOUT instead of ERR_SSRF_BLOCKED).

function requestError(mod: typeof http | typeof https, agent: http.Agent, url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { agent }, () => reject(new Error("request unexpectedly succeeded")));
    req.on("error", resolve);
    req.setTimeout(5000, () => req.destroy(new Error("timeout — guard did not fire")));
  });
}

const PRIVATE_URLS = [
  "http://127.0.0.1:9/",
  "http://169.254.169.254/latest/meta-data/",
  "http://10.0.0.5/",
  "http://[::1]:9/",
  "http://[::ffff:127.0.0.1]:9/",
  "http://[::ffff:a9fe:a9fe]/",
  "http://198.18.0.1/",
  "http://localhost:9/",
];

test("SafeHttpAgent refuses private IP-literal targets before connecting", async () => {
  const agent = new SafeHttpAgent();
  try {
    for (const url of PRIVATE_URLS) {
      const err = await requestError(http, agent, url);
      assert.equal(err.code, "ERR_SSRF_BLOCKED", `${url}: ${err.message}`);
    }
  } finally {
    agent.destroy();
  }
});

test("SafeHttpsAgent refuses private IP-literal targets before connecting", async () => {
  const agent = new SafeHttpsAgent();
  try {
    for (const url of PRIVATE_URLS.map((u) => u.replace(/^http:/, "https:"))) {
      const err = await requestError(https, agent, url);
      assert.equal(err.code, "ERR_SSRF_BLOCKED", `${url}: ${err.message}`);
    }
  } finally {
    agent.destroy();
  }
});

test("createConnection on a private literal errors via callback (no socket)", async () => {
  const agent = new SafeHttpAgent();
  const err = await new Promise<any>((resolve) => {
    const sock = (agent as any).createConnection({ host: "127.0.0.1", port: 9 }, (e: any) => resolve(e));
    assert.equal(sock, undefined);
  });
  assert.equal(err?.code, "ERR_SSRF_BLOCKED");
  agent.destroy();
});

test("an agent locked to one host refuses any other host (cross-host redirect)", async () => {
  const agent = new SafeHttpAgent({ allowedHost: "dav.example.com" });
  try {
    // Public IP, but not the locked host — refused before any connect.
    const err = await requestError(http, agent, "http://8.8.8.8/");
    assert.equal(err.code, "ERR_SSRF_BLOCKED");
    assert.match(err.message, /only dav\.example\.com is allowed/);
  } finally {
    agent.destroy();
  }
});

test("connectTargetViolation classifies targets", () => {
  assert.equal(connectTargetViolation("8.8.8.8"), null);
  assert.equal(connectTargetViolation("dav.example.com"), null);
  assert.equal(connectTargetViolation("DAV.example.com.", "dav.example.com"), null);
  assert.notEqual(connectTargetViolation("127.0.0.1"), null);
  assert.notEqual(connectTargetViolation("[::ffff:127.0.0.1]"), null);
  assert.notEqual(connectTargetViolation("evil.example.com", "dav.example.com"), null);
  assert.notEqual(connectTargetViolation(""), null);
});

test("safeLookup refuses names that resolve to loopback", async () => {
  const err = await new Promise<any>((resolve) => safeLookup("localhost", { all: true }, (e: any) => resolve(e)));
  assert.ok(err instanceof Error);
  assert.match(err.message, /Blocked connection to private address/);
});
