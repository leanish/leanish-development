import { describe, expect, it } from "vitest";

import { ageDays, DAY_MS, eligibleAt, hasAged, isUnderWait } from "../src/age.ts";

const NOW = new Date("2026-10-27T12:00:00Z");
const daysAgo = (days: number, ms = 0) => new Date(NOW.getTime() - days * DAY_MS + ms);

describe("release age", () => {
  it("has aged at the exact threshold, not a millisecond before, and never in the future", () => {
    expect(hasAged(daysAgo(7), 7, NOW)).toBe(true);
    expect(hasAged(daysAgo(7, 1), 7, NOW)).toBe(false);
    expect(hasAged(daysAgo(7).getTime(), 7, NOW)).toBe(true);
    expect(hasAged(daysAgo(-1), 0, NOW)).toBe(false);
    expect(hasAged(NOW, 0, NOW)).toBe(true);
  });

  it("never treats an unknown or unreadable date as aged, nor as young", () => {
    expect(hasAged(undefined, 0, NOW)).toBe(false);
    expect(hasAged(Number.NaN, 0, NOW)).toBe(false);
    expect(hasAged(new Date("not a date"), 0, NOW)).toBe(false);
    expect(() => isUnderWait(new Date("not a date"), 7, NOW)).toThrow("can't be judged against the wait");
    expect(isUnderWait(daysAgo(6), 7, NOW)).toBe(true);
    expect(isUnderWait(daysAgo(7), 7, NOW)).toBe(false);
  });

  it("gives the age in days and when the wait ends", () => {
    expect(ageDays(daysAgo(1.5), NOW)).toBe(1.5);
    expect(ageDays(undefined, NOW)).toBeUndefined();
    expect(eligibleAt(daysAgo(2), 7).toISOString()).toBe(new Date(NOW.getTime() + 5 * DAY_MS).toISOString());
  });
});
