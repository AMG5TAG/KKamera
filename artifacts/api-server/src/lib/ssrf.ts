import net from "net";
import dns from "dns";
import http from "http";
import https from "https";

// ─── SSRF address classification ──────────────────────────────────────────────
// User-supplied FTP/WebDAV hosts are attacker-controlled. Without this guard a
// user could point a connection at internal infrastructure (cloud metadata at
// 169.254.169.254, localhost services, RFC-1918 hosts) and use the test/upload
// endpoints as an SSRF pivot. These helpers classify an IP literal as private so
// callers can refuse it (see cloudUpload.ts).

export function isPrivateIpv4(a: number, b: number, c = -1): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;             // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16/12
  if (a === 192 && b === 168) return true;             // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a === 192 && b === 0 && c === 0) return true;    // IETF protocol assignments 192.0.0/24
  if (a >= 224) return true;                           // multicast / reserved
  return false;
}

/** Expand an IPv6 literal (any notation, incl. embedded IPv4) to its 16 bytes, or null. */
export function ipv6ToBytes(ip: string): number[] | null {
  let s = ip.split("%")[0]!; // drop zone id
  // Convert a trailing embedded IPv4 (e.g. ::ffff:127.0.0.1) into two hextets.
  const v4 = s.match(/(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = [v4[2], v4[3], v4[4], v4[5]].map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${v4[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const groups = tail === null
    ? head
    : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

/** True if an IP literal falls in a private / loopback / link-local / reserved range. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
    return isPrivateIpv4(a, b, c);
  }
  if (net.isIPv6(ip)) {
    const x = ipv6ToBytes(ip);
    if (!x) return true; // unparseable → treat as unsafe
    if (x.every((n) => n === 0)) return true;                                  // ::
    if (x.slice(0, 15).every((n) => n === 0) && x[15] === 1) return true;      // ::1
    if (x[0] === 0xfe && (x[1]! & 0xc0) === 0x80) return true;                 // fe80::/10 link-local
    if ((x[0]! & 0xfe) === 0xfc) return true;                                  // fc00::/7 ULA
    // Block any IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), or NAT64
    // (64:ff9b::/96) address — these can target internal v4 via an IPv6 literal
    // and are never needed for a legitimate public cloud host.
    if (x.slice(0, 10).every((n) => n === 0) && x[10] === 0xff && x[11] === 0xff) return true;
    if (x.slice(0, 12).every((n) => n === 0)) return true;
    if (x[0] === 0x00 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b) return true; // 64:ff9b::/96 + 64:ff9b:1::/48
    if (x[0] === 0xff) return true;                                            // ff00::/8 multicast
    if (x[0] === 0x01 && x[1] === 0x00 && x.slice(2, 8).every((n) => n === 0)) return true; // 100::/64 discard
    // Teredo (2001:0::/32) tunnels to an obfuscated IPv4 we can't meaningfully
    // vet — never a legitimate cloud host, so refuse the whole prefix.
    if (x[0] === 0x20 && x[1] === 0x01 && x[2] === 0x00 && x[3] === 0x00) return true;
    // 6to4 (2002::/16) embeds an IPv4 in bytes 2–5; refuse when that v4 is private.
    if (x[0] === 0x20 && x[1] === 0x02 && isPrivateIpv4(x[2]!, x[3]!, x[4]!)) return true;
    return false;
  }
  return true; // not a valid IP → unsafe
}

// ─── Connect-time enforcement ─────────────────────────────────────────────────
// Validating the host once up-front isn't enough: DNS can rebind between the
// check and the connect, and an HTTP client following a redirect (node-fetch,
// under the webdav client, re-sends PUT bodies on 307/308) will happily connect
// to `Location: http://169.254.169.254/`. A redirect to an IP *literal* never
// calls the agent's `lookup`, so the lookup check alone doesn't cover it. The
// agents below therefore check at three points on every new socket:
//   1. the target host itself, when it is an IP literal (createConnection);
//   2. every resolved address, when it is a name (safeLookup);
//   3. the socket's actual peer address once connected (backstop).
// Optionally they are also locked to a single hostname, which turns any
// cross-host redirect into a hard failure.

/** Strip IPv6 brackets and any trailing dot so the host can be classified. */
function bareHost(host: unknown): string {
  return String(host ?? "").replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/**
 * A `dns.lookup` replacement that refuses private results. Handles both the
 * single-address and `{ all: true }` (happy-eyeballs) callback shapes.
 */
export function safeLookup(hostname: string, options: any, callback: any): void {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : (options ?? {});
  dns.lookup(hostname, opts, (err: any, address: any, family: any) => {
    if (err) return cb(err, address, family);
    const list = Array.isArray(address) ? address : [{ address, family }];
    for (const a of list) {
      if (isPrivateIp(a.address)) {
        return cb(new Error(`Blocked connection to private address ${a.address} (${hostname})`));
      }
    }
    cb(null, address, family);
  });
}

/** Why a connection to `host` must be refused, or null when it may proceed. */
export function connectTargetViolation(host: unknown, allowedHost?: string | null): string | null {
  const h = bareHost(host);
  if (!h) return "Blocked connection: missing host";
  if (allowedHost && h !== bareHost(allowedHost)) {
    return `Blocked connection to ${h}: only ${bareHost(allowedHost)} is allowed (cross-host redirect?)`;
  }
  if (h === "localhost" || h.endsWith(".localhost")) return `Blocked connection to ${h}`;
  if (net.isIP(h) && isPrivateIp(h)) return `Blocked connection to private address ${h}`;
  return null;
}

export interface SafeAgentOptions {
  /** When set, every connection must target exactly this hostname. */
  allowedHost?: string | null;
}

type CreateConn = (options: any, cb?: (err: Error | null, socket?: net.Socket) => void) => net.Socket | undefined;

/**
 * Wrap an Agent's createConnection with the SSRF checks. The error is handed to
 * the Agent through the callback (on the next tick) rather than thrown, which
 * is how http.Agent expects an async createConnection to fail — the request
 * then emits 'error' instead of crashing the process.
 */
function guardedCreateConnection(original: CreateConn, allowedHost: string | null): CreateConn {
  return function (this: unknown, options: any, cb?: (err: Error | null, socket?: net.Socket) => void) {
    const violation = connectTargetViolation(options?.host ?? options?.hostname, allowedHost);
    if (violation) {
      const err = Object.assign(new Error(violation), { code: "ERR_SSRF_BLOCKED" });
      if (cb) {
        process.nextTick(() => cb(err));
        return undefined;
      }
      throw err;
    }
    const socket = original.call(this, { ...options, lookup: safeLookup }, cb);
    if (socket) {
      socket.once("connect", () => {
        const remote = socket.remoteAddress;
        if (remote && isPrivateIp(remote)) {
          socket.destroy(Object.assign(new Error(`Blocked connection to private address ${remote}`), { code: "ERR_SSRF_BLOCKED" }));
        }
      });
    }
    return socket;
  };
}

/** http.Agent that refuses private / non-allowed targets (see above). */
export class SafeHttpAgent extends http.Agent {
  constructor(opts: http.AgentOptions & SafeAgentOptions = {}) {
    const { allowedHost = null, ...rest } = opts;
    super({ ...rest, lookup: safeLookup as any });
    (this as any).createConnection = guardedCreateConnection((http.Agent.prototype as any).createConnection, allowedHost);
  }
}

/** https.Agent that refuses private / non-allowed targets (see above). */
export class SafeHttpsAgent extends https.Agent {
  constructor(opts: https.AgentOptions & SafeAgentOptions = {}) {
    const { allowedHost = null, ...rest } = opts;
    super({ ...rest, lookup: safeLookup as any });
    (this as any).createConnection = guardedCreateConnection((https.Agent.prototype as any).createConnection, allowedHost);
  }
}
