/**
 * In-process per-IP connection guard (spec 13: basic per-IP connection limits
 * to prevent room flooding). Counts act per room sessions; released on leave.
 */

const ipCounts = new Map<string, number>();

export function ipAcquire(ip: string | undefined, limit: number): boolean {
  if (!ip) return true; // tests and local tooling may have no peer address
  const n = (ipCounts.get(ip) ?? 0) + 1;
  if (n > limit) return false;
  ipCounts.set(ip, n);
  return true;
}

export function ipRelease(ip: string | undefined): void {
  if (!ip) return;
  const n = (ipCounts.get(ip) ?? 0) - 1;
  if (n <= 0) ipCounts.delete(ip);
  else ipCounts.set(ip, n);
}

export function ipCount(ip: string | undefined): number {
  return ip ? (ipCounts.get(ip) ?? 0) : 0;
}
