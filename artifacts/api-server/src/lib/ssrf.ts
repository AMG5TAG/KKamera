import net from "net";

// ─── SSRF address classification ──────────────────────────────────────────────
// User-supplied FTP/WebDAV hosts are attacker-controlled. Without this guard a
// user could point a connection at internal infrastructure (cloud metadata at
// 169.254.169.254, localhost services, RFC-1918 hosts) and use the test/upload
// endpoints as an SSRF pivot. These helpers classify an IP literal as private so
// callers can refuse it (see cloudUpload.ts).

export function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;             // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16/12
  if (a === 192 && b === 168) return true;             // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT 100.64/10
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
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return isPrivateIpv4(a, b);
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
    if (x[0] === 0x00 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b) return true;
    return false;
  }
  return true; // not a valid IP → unsafe
}
