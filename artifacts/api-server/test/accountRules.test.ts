import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newPasswordSchema, normalizedEmailSchema, normalizeReferralCode,
  isTrialReminderDue, trialDaysLeft, buildUserExport, retainTargetIds, type ExportSource,
} from "../src/lib/accountRules.ts";

const DAY = 86_400_000;

// ─── Password rule ────────────────────────────────────────────────────────────

test("password: rejects fewer than 8 characters", () => {
  assert.equal(newPasswordSchema.safeParse("1234567").success, false);
  assert.equal(newPasswordSchema.safeParse("12345678").success, true);
});

test("password: accepts exactly 72 ASCII bytes, rejects 73", () => {
  assert.equal(newPasswordSchema.safeParse("a".repeat(72)).success, true);
  assert.equal(newPasswordSchema.safeParse("a".repeat(73)).success, false);
});

test("password: max is measured in UTF-8 bytes, not characters", () => {
  // "é" is 2 bytes: 36 chars = 72 bytes OK, 37 chars = 74 bytes rejected even
  // though a character-count cap of 72 would have allowed it.
  assert.equal(newPasswordSchema.safeParse("é".repeat(36)).success, true);
  assert.equal(newPasswordSchema.safeParse("é".repeat(37)).success, false);
  // 4-byte emoji: 18 = 72 bytes OK, 19 rejected.
  assert.equal(newPasswordSchema.safeParse("😀".repeat(18)).success, true);
  assert.equal(newPasswordSchema.safeParse("😀".repeat(19)).success, false);
});

// ─── Email / referral normalisation ───────────────────────────────────────────

test("email: trims and lowercases before validating (autofill trailing space)", () => {
  const r = normalizedEmailSchema.safeParse("  Jane@Example.COM \n");
  assert.equal(r.success, true);
  assert.equal(r.success && r.data, "jane@example.com");
  assert.equal(normalizedEmailSchema.safeParse("not-an-email ").success, false);
});

test("referral code: trimmed and uppercased; blank → null", () => {
  assert.equal(normalizeReferralCode("  jane1a2b3c "), "JANE1A2B3C");
  assert.equal(normalizeReferralCode("   "), null);
  assert.equal(normalizeReferralCode(null), null);
  assert.equal(normalizeReferralCode(undefined), null);
});

// ─── Trial reminder due-date logic ────────────────────────────────────────────

const now = new Date("2026-01-10T12:00:00Z");
const at = (ms: number) => new Date(now.getTime() + ms);

test("reminder: due for a trial ending within 3 days, not yet sent", () => {
  assert.equal(isTrialReminderDue({ status: "trial", trialEnd: at(2 * DAY), trialReminderSentAt: null }, now), true);
  assert.equal(isTrialReminderDue({ status: "trial", trialEnd: at(3 * DAY), trialReminderSentAt: null }, now), true);
  assert.equal(isTrialReminderDue({ status: "trial", trialEnd: at(60_000), trialReminderSentAt: null }, now), true);
});

test("reminder: not due when too early, already ended, or already sent", () => {
  assert.equal(isTrialReminderDue({ status: "trial", trialEnd: at(3 * DAY + 1), trialReminderSentAt: null }, now), false);
  assert.equal(isTrialReminderDue({ status: "trial", trialEnd: at(0), trialReminderSentAt: null }, now), false);
  assert.equal(isTrialReminderDue({ status: "trial", trialEnd: at(-DAY), trialReminderSentAt: null }, now), false);
  assert.equal(isTrialReminderDue({ status: "trial", trialEnd: at(DAY), trialReminderSentAt: at(-DAY) }, now), false);
});

test("reminder: not due for non-trial statuses or a trial with no end date", () => {
  for (const status of ["active", "cancelled", "past_due", "expired", "none"]) {
    assert.equal(isTrialReminderDue({ status, trialEnd: at(DAY), trialReminderSentAt: null }, now), false);
  }
  assert.equal(isTrialReminderDue({ status: "trial", trialEnd: null, trialReminderSentAt: null }, now), false);
});

test("trialDaysLeft rounds up and never reports 0", () => {
  assert.equal(trialDaysLeft(at(3 * DAY), now), 3);
  assert.equal(trialDaysLeft(at(2 * DAY + 1), now), 3);
  assert.equal(trialDaysLeft(at(DAY), now), 1);
  assert.equal(trialDaysLeft(at(60_000), now), 1);
});

// ─── GDPR export shape ────────────────────────────────────────────────────────

function source(): ExportSource {
  const created = new Date("2026-01-01T00:00:00Z");
  return {
    user: {
      id: 7, email: "a@b.co", name: "A", referralCode: "AAA123456",
      twoFAEnabled: true, onboardingCompleted: true,
      uploadTargetMode: "selected", uploadTargetIds: "3, 5,x,-1",
      createdAt: created,
    },
    subscription: {
      status: "trial", trialStart: created, trialEnd: new Date("2026-01-15T00:00:00Z"),
      currentPeriodEnd: null, freeYearsAwarded: 0, createdAt: created,
    },
    cloudConnections: [{
      id: 3, type: "ftp", provider: null, name: "NAS", host: "ftp.example.com", port: 21,
      username: "me", uploadPath: "/pics", accountLabel: null, active: true, createdAt: created,
      // Extra runtime fields (as if a wider row were passed) must not leak.
      ...({ passwordEncrypted: "SECRET", accessTokenEncrypted: "SECRET", refreshToken: "SECRET" } as object),
    }],
    referralsMade: [{ id: 1, referredName: "B", status: "pending", createdAt: created }],
    referredBy: [{ id: 2, status: "completed", createdAt: created }],
    uploads: [],
    feedback: [{ id: 4, type: "bug", message: "hi", createdAt: created }],
  };
}

test("export: includes all sections with ISO dates and parsed upload target", () => {
  const out = buildUserExport(source(), new Date("2026-02-01T00:00:00Z"));
  assert.equal(out.exportedAt, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(out.uploadTarget, { mode: "selected", connectionIds: [3, 5] });
  assert.equal(out.subscription?.trialEnd, "2026-01-15T00:00:00.000Z");
  assert.equal(out.subscription?.currentPeriodEnd, null);
  assert.equal(out.cloudConnections[0]?.host, "ftp.example.com");
  assert.equal(out.cloudConnections[0]?.uploadPath, "/pics");
  assert.equal(out.referrals.length, 1);
  assert.deepEqual(out.referredBy, [{ id: 2, status: "completed", createdAt: "2026-01-01T00:00:00.000Z" }]);
  assert.equal(out.feedback[0]?.message, "hi");
});

test("export: never contains credential/secret fields", () => {
  const json = JSON.stringify(buildUserExport(source(), now));
  assert.equal(json.includes("SECRET"), false);
  for (const key of ["passwordEncrypted", "accessTokenEncrypted", "refreshToken", "passwordHash", "twoFASecret", "twoFABackupCodes"]) {
    assert.equal(json.includes(`"${key}"`), false, key);
  }
});

test("export: null subscription stays null", () => {
  const src = source();
  src.subscription = null;
  assert.equal(buildUserExport(src, now).subscription, null);
});

// ─── Upload target pruning ────────────────────────────────────────────────────

test("retainTargetIds: drops ids that no longer exist", () => {
  assert.equal(retainTargetIds("3,7,9", [3, 9, 12]), "3,9");
});

test("retainTargetIds: an emptied list becomes null (upload nowhere), never 'all'", () => {
  assert.equal(retainTargetIds("7", []), null);
  assert.equal(retainTargetIds("7", [8]), null);
  assert.equal(retainTargetIds(null, [1]), null);
});
