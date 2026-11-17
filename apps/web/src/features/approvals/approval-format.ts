/** Display helpers for the approvals inbox (AGO-37). Pure, so the card and its tests share one definition. */

function hoursAndMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes)} min`;
}

/** "just now", "5 min", "2 h 10 min", "3 d": how long a request has been waiting. */
export function formatAge(fromIso: string, nowMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / 1000));
  if (Number.isNaN(elapsedSeconds)) return "unknown";
  if (elapsedSeconds < 60) return "just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  if (minutes < 24 * 60) return hoursAndMinutes(minutes);
  return `${String(Math.floor(minutes / (24 * 60)))} d`;
}

/** Time left before the request times out (timeout means deny). "expired" once past. */
export function formatTimeLeft(expiresIso: string, nowMs: number): string {
  const remaining = Date.parse(expiresIso) - nowMs;
  if (Number.isNaN(remaining) || remaining <= 0) return "expired";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${String(minutes)} min left`;
  return `${hoursAndMinutes(minutes)} left`;
}

/** Cost in micros (millionths of a dollar) as dollars. Null means the run reported no cost. */
export function formatCostMicros(costMicros: number | null): string {
  if (costMicros === null) return "not reported";
  const dollars = costMicros / 1_000_000;
  return dollars < 0.01 && costMicros > 0 ? "< $0.01" : `$${dollars.toFixed(2)}`;
}
