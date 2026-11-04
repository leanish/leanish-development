import { describe, expect, it } from "vitest";

import { youngAt } from "../src/young-at.ts";

describe("youngAt", () => {
  const now = new Date("2026-11-04T12:00:00.000Z");

  it.each([
    { until: "2026-11-04T12:00:00.001Z", young: true },
    { until: "2026-11-04T12:00:00.000Z", young: false },
    { until: "2026-11-04T11:59:59.999Z", young: false },
    { until: "2026-11-04T14:00:00.000+02:00", young: false },
    { until: undefined, young: true },
    { until: "unknown", young: true },
    { until: "not a date", young: true },
  ])("counts $until as young: $young", ({ until, young }) => {
    expect(youngAt(until, now)).toBe(young);
  });
});
