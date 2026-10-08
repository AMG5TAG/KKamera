// Pure alpha-tester allowlist — no imports, so it's unit-testable
// (see test/testerAccess.test.ts).
//
// TESTER_EMAILS is a comma-separated list of account emails that always have
// upload access. TestFlight / Play internal-track purchases are sandbox and
// are ignored in production (ALLOW_SANDBOX_IAP), and the trial is 24 hours, so
// without this testers are blocked from day 2. Remove the env var at launch.

/** Parse TESTER_EMAILS into a set of lower-cased, trimmed addresses. */
export function parseTesterEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@")),
  );
}

/** True when `email` is on the TESTER_EMAILS allowlist (exact, case-insensitive). */
export function isTesterEmail(
  email: string | null | undefined,
  raw: string | undefined = process.env["TESTER_EMAILS"],
): boolean {
  if (!email) return false;
  return parseTesterEmails(raw).has(email.trim().toLowerCase());
}
