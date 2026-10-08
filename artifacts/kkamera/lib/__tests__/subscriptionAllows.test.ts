import { subscriptionAllows, type SubscriptionSnapshot } from "../offlineCache";

// Client mirror of the server's evaluateAccess. These cases mirror
// artifacts/api-server/test/subscriptionAccess.test.ts so the camera gate and
// the upload endpoint can't disagree about who may upload.
const NOW = Date.parse("2026-01-01T00:00:00Z");
const future = (ms: number) => new Date(NOW + ms).toISOString();
const past = (ms: number) => new Date(NOW - ms).toISOString();
const DAY = 86_400_000;

describe("subscriptionAllows", () => {
  it("denies when there is no snapshot", () => {
    expect(subscriptionAllows(null, NOW)).toBe(false);
    expect(subscriptionAllows(undefined, NOW)).toBe(false);
  });

  it("denies an unknown status", () => {
    expect(subscriptionAllows({ status: "none" }, NOW)).toBe(false);
    expect(subscriptionAllows({ status: "paused" }, NOW)).toBe(false);
  });

  describe("trial", () => {
    it("allows while trialEnd is in the future, denies once it passes", () => {
      expect(subscriptionAllows({ status: "trial", trialEnd: future(DAY) }, NOW)).toBe(true);
      expect(subscriptionAllows({ status: "trial", trialEnd: past(1) }, NOW)).toBe(false);
    });
    it("allows exactly at trialEnd (>= now) and denies with no end date", () => {
      expect(subscriptionAllows({ status: "trial", trialEnd: new Date(NOW).toISOString() }, NOW)).toBe(true);
      expect(subscriptionAllows({ status: "trial", trialEnd: null }, NOW)).toBe(false);
    });
  });

  describe("active", () => {
    it("allows until currentPeriodEnd, denies after and when missing", () => {
      expect(subscriptionAllows({ status: "active", currentPeriodEnd: future(DAY) }, NOW)).toBe(true);
      expect(subscriptionAllows({ status: "active", currentPeriodEnd: past(1) }, NOW)).toBe(false);
      expect(subscriptionAllows({ status: "active", currentPeriodEnd: null }, NOW)).toBe(false);
    });
  });

  describe("cancelled", () => {
    it("keeps access until the paid period (or trial) elapses — strictly after now", () => {
      expect(subscriptionAllows({ status: "cancelled", currentPeriodEnd: future(DAY) }, NOW)).toBe(true);
      expect(subscriptionAllows({ status: "cancelled", currentPeriodEnd: null, trialEnd: future(DAY) }, NOW)).toBe(true);
      expect(subscriptionAllows({ status: "cancelled", currentPeriodEnd: new Date(NOW).toISOString() }, NOW)).toBe(false);
      expect(subscriptionAllows({ status: "cancelled" }, NOW)).toBe(false);
    });
  });

  describe("past_due", () => {
    it("allows within the 14-day grace past currentPeriodEnd, denies beyond", () => {
      expect(subscriptionAllows({ status: "past_due", currentPeriodEnd: past(13 * DAY) }, NOW)).toBe(true);
      expect(subscriptionAllows({ status: "past_due", currentPeriodEnd: past(15 * DAY) }, NOW)).toBe(false);
      expect(subscriptionAllows({ status: "past_due", currentPeriodEnd: null }, NOW)).toBe(false);
    });
  });

  it("treats an unparseable date as no date (denies)", () => {
    expect(subscriptionAllows({ status: "trial", trialEnd: "not-a-date" }, NOW)).toBe(false);
  });
});
