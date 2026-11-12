import type { TLSSocket } from "tls";

/**
 * Trust-on-first-use certificate pinning for self-hosted servers (FTPS,
 * WebDAV/Nextcloud over HTTPS) whose owner opted in to "trust self-signed
 * certificate" on the connection.
 *
 * The pin column holds either a leaf fingerprint or the CA_VALID_PIN marker:
 *
 *  - A certificate that validates normally (public CA + hostname) is always
 *    accepted — so Let's Encrypt renewals keep working — and the connection is
 *    marked CA_VALID_PIN (replacing any fingerprint pin).
 *  - Once marked, a certificate that does NOT validate is refused: the server
 *    is known to present a real certificate, so a self-signed one is an
 *    interception, never a "first use".
 *  - Otherwise the leaf certificate's SHA-256 fingerprint must match the pin;
 *    when there is no pin yet, the first one seen is accepted and the caller
 *    persists it.
 *
 * A socket that resumed an earlier TLS session proved it is the peer that
 * session was negotiated with (which was itself checked), so it is accepted too.
 *
 * The check runs in the socket's 'secureConnect' handler, which Node emits
 * synchronously on handshake completion — the same point where
 * rejectUnauthorized destroys an untrusted socket — so destroying it there
 * means no application data (credentials, file bytes) reaches a mismatched peer.
 *
 * The decision is pure (unit-tested in test/tlsPin.test.ts).
 */

export type PinDecision = "ok" | "ca_valid" | "first_use" | "mismatch";

/**
 * Stored in cloud_connections.tls_pin_sha256 once the server has presented a
 * CA-valid certificate (not a hex fingerprint, so it can never match one).
 */
export const CA_VALID_PIN = "ca-valid";

export interface PinInput {
  /** socket.authorized — chain and hostname validated. */
  authorized: boolean;
  /** socket.isSessionReused() */
  sessionReused: boolean;
  /** Leaf fingerprint (colon-separated hex, as Node reports fingerprint256), or null. */
  fingerprint: string | null;
  /** Pin stored on the connection (or seen earlier in this operation): a fingerprint, CA_VALID_PIN, or null. */
  pin: string | null;
}

/** Normalise a fingerprint for comparison (case and separators don't matter). */
export function normalizeFingerprint(fp: string | null | undefined): string | null {
  if (!fp) return null;
  const hex = fp.replace(/[^0-9a-f]/gi, "").toUpperCase();
  return hex.length === 64 ? hex : null;
}

/** Normalise a stored pin: CA_VALID_PIN, a normalised fingerprint, or null. */
export function normalizePin(pin: string | null | undefined): string | null {
  return pin === CA_VALID_PIN ? CA_VALID_PIN : normalizeFingerprint(pin);
}

/**
 * "ca_valid": accepted, and the caller should record CA_VALID_PIN if it isn't
 * already the pin. "first_use": accepted, record the fingerprint.
 */
export function pinDecision(input: PinInput): PinDecision {
  const pin = normalizePin(input.pin);
  if (input.authorized) return pin === CA_VALID_PIN ? "ok" : "ca_valid";
  if (input.sessionReused) return "ok";
  const fp = normalizeFingerprint(input.fingerprint);
  if (!fp || pin === CA_VALID_PIN) return "mismatch";
  if (!pin) return "first_use";
  return fp === pin ? "ok" : "mismatch";
}

export function tlsPinMismatchError(): Error {
  return Object.assign(new Error("TLS certificate does not match the pinned certificate for this connection"), {
    code: "TLS_PIN_MISMATCH",
  });
}

/**
 * Per-operation pin state for one connection. `check` is called for every
 * TLS socket opened to the server; a pin learned during the operation (the
 * first unpinned self-signed certificate, or CA_VALID_PIN when a CA-valid one
 * is seen) becomes `observed` — to be persisted by the caller — and every
 * later socket in the operation is checked against it.
 */
export class TlsPinGuard {
  observed: string | null = null;
  private readonly stored: string | null;

  constructor(stored: string | null) {
    this.stored = normalizePin(stored);
  }

  /** The pin in force: the one learned in this operation, else the stored one. */
  get pin(): string | null {
    return this.observed ?? this.stored;
  }

  /** The pin to persist after the operation, or null when the stored one is current. */
  get toPersist(): string | null {
    return this.observed && this.observed !== this.stored ? this.observed : null;
  }

  /** Returns an error when the socket must be refused, else null (recording any new pin). */
  check(socket: TLSSocket): Error | null {
    let fingerprint: string | null = null;
    try {
      fingerprint = socket.getPeerCertificate()?.fingerprint256 ?? null;
    } catch { /* no certificate */ }
    const decision = pinDecision({
      authorized: socket.authorized,
      sessionReused: socket.isSessionReused(),
      fingerprint,
      pin: this.pin,
    });
    if (decision === "mismatch") return tlsPinMismatchError();
    if (decision === "first_use") this.observed = normalizeFingerprint(fingerprint);
    if (decision === "ca_valid") this.observed = CA_VALID_PIN;
    return null;
  }
}
