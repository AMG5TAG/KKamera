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

test("blocks the additional reserved IPv4 ranges", () => {
  for (const ip of ["198.18.0.1", "198.19.255.255", "192.0.0.1", "192.0.0.170", "100.127.255.255"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["198.17.255.255", "198.20.0.1", "192.0.1.1", "192.1.0.1"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("blocks IPv6 multicast, Teredo and 6to4-wrapped private IPv4", () => {
  for (const ip of [
    "ff02::1", "ff05::2",       // multicast
    "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo 2001:0::/32
    "2002:7f00:1::1",           // 6to4 → 127.0.0.1
    "2002:a9fe:a9fe::1",        // 6to4 → 169.254.169.254
    "2002:c0a8:0101::1",        // 6to4 → 192.168.1.1
    "100::1",                   // discard-only
  ]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  // 6to4 wrapping a public v4 and ordinary 2001:x (non-Teredo) stay allowed.
  for (const ip of ["2002:0808:0808::1", "2001:db8:1::1", "2001:4860:4860::8844"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});
