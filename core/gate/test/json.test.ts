import { describe, expect, it } from "vitest";

import { isObject } from "../src/json.ts";

describe("isObject", () => {
  // The one guard every tool parses untrusted JSON (lockfiles, manifests, PR records, journals) with.
  it.each([
    { value: {}, object: true },
    { value: { a: 1 }, object: true },
    { value: Object.create(null), object: true },
    { value: new (class Recorded {})(), object: true },
    { value: null, object: false },
    { value: [], object: false },
    { value: [{}], object: false },
    { value: "{}", object: false },
    { value: 1, object: false },
    { value: true, object: false },
    { value: undefined, object: false },
  ])("counts $value as an object: $object", ({ value, object }) => {
    expect(isObject(value)).toBe(object);
  });
});
