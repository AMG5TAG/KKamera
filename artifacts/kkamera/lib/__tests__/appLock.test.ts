import { lockoutMsForFailures, PIN_FAIL_THRESHOLD, RELOCK_GRACE_MS } from "../appLock";

describe("lockoutMsForFailures", () => {
  it("no lockout below the failure threshold", () => {
    for (let f = 0; f < PIN_FAIL_THRESHOLD; f++) {
      expect(lockoutMsForFailures(f)).toBe(0);
    }
  });

  it("starts at 30s on the threshold and doubles each further failure", () => {
    expect(lockoutMsForFailures(PIN_FAIL_THRESHOLD)).toBe(30_000);
    expect(lockoutMsForFailures(PIN_FAIL_THRESHOLD + 1)).toBe(60_000);
    expect(lockoutMsForFailures(PIN_FAIL_THRESHOLD + 2)).toBe(120_000);
    expect(lockoutMsForFailures(PIN_FAIL_THRESHOLD + 3)).toBe(240_000);
  });

  it("caps at 5 minutes no matter how many failures", () => {
    expect(lockoutMsForFailures(PIN_FAIL_THRESHOLD + 4)).toBe(300_000);
    expect(lockoutMsForFailures(PIN_FAIL_THRESHOLD + 50)).toBe(300_000);
    expect(lockoutMsForFailures(1000)).toBe(300_000);
  });

  it("the backoff never decreases as failures grow", () => {
    let prev = -1;
    for (let f = 0; f <= PIN_FAIL_THRESHOLD + 10; f++) {
      const ms = lockoutMsForFailures(f);
      expect(ms).toBeGreaterThanOrEqual(prev);
      prev = ms;
    }
  });
});

describe("appLock constants", () => {
  it("exposes a sane re-lock grace period", () => {
    expect(RELOCK_GRACE_MS).toBe(30_000);
  });
});
