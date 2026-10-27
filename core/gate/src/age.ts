/**
 * The release-age arithmetic every part shares: a version has aged once `days` whole days have passed since it was
 * published, the exact threshold included. A publication in the future hasn't aged, and an unknown or unreadable
 * date never has: an age that can't be read is never an exemption.
 */

/** One day in milliseconds. */
export const DAY_MS = 86_400_000;

/** Whether a version published at `published` (a date or epoch milliseconds) has waited `days` by `now`. */
export function hasAged(published: Date | number | undefined, days: number, now: Date): boolean {
  const time = published instanceof Date ? published.getTime() : published;
  return time !== undefined && Number.isFinite(time) && now.getTime() - time >= days * DAY_MS;
}

/** Its age in (fractional) days at `now`; undefined when the date is unknown. */
export function ageDays(published: Date | undefined, now: Date): number | undefined {
  return published === undefined ? undefined : (now.getTime() - published.getTime()) / DAY_MS;
}

/** When a version published at `published` will have waited `days`. */
export function eligibleAt(published: Date, days: number): Date {
  return new Date(published.getTime() + days * DAY_MS);
}

/**
 * Whether a version published at `published` is still under the `days` wait at `now`: what makes it young, and so
 * what an exemption or a hold applies to. Its date must be known; an unreadable one throws rather than read as young.
 */
export function isUnderWait(published: Date, days: number, now: Date): boolean {
  if (!Number.isFinite(published.getTime())) throw new Error("a publish time that can't be read can't be judged against the wait");
  return !hasAged(published, days, now);
}
