import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateIp } from "../src/lib/ssrf.ts";

test("blocks IPv4 private / loopback / reserved ranges", () => {
  for (const ip of [
    "127.0.0.1", "10.0.0.1", "172.16.5.5", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
  ]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
});

test("allows public IPv4", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.10", "172.32.0.1", "100.63.0.1"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("blocks IPv6 loopback / unspecified / ULA / link-local", () => {
  for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
});

test("blocks IPv4-mapped/embedded IPv6 in every notation (the SSRF-bypass class)", () => {
  for (const ip of [
    "::ffff:7f00:1",          // hex IPv4-mapped 127.0.0.1
    "::ffff:a9fe:a9fe",       // hex IPv4-mapped 169.254.169.254 (cloud metadata)
    "::ffff:127.0.0.1",       // decimal IPv4-mapped loopback
    "::ffff:169.254.169.254", // decimal IPv4-mapped metadata
    "64:ff9b::a9fe:a9fe",     // NAT64 -> metadata
    "::127.0.0.1",            // IPv4-compatible loopback
  ]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
});

test("allows public IPv6", () => {
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("treats anything that isn't a valid IP as unsafe", () => {
  for (const v of ["not-an-ip", "", "999.999.999.999", "::ffff:999.0.0.1"]) {
    assert.equal(isPrivateIp(v), true, v);
  }
});
