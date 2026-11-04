/** A deadline is young until it passes, including an unknown date; the exact threshold has aged. */
export function youngAt(until: string | undefined, now: Date): boolean {
  return until === undefined || !(Date.parse(until) <= now.getTime());
}
