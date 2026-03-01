import type { TmuxSession } from '../types';

/**
 * Sort sessions by a given order array (from backend).
 * Sessions not in the order array are placed at the end.
 */
export function sortSessionsByOrder(sessions: TmuxSession[], order: string[]): TmuxSession[] {
  if (order.length === 0) return sessions;
  const orderMap = new Map(order.map((id, idx) => [id, idx]));
  return [...sessions].sort((a, b) => {
    const ia = orderMap.get(a.id) ?? Infinity;
    const ib = orderMap.get(b.id) ?? Infinity;
    if (ia === Infinity && ib === Infinity) return 0;
    return ia - ib;
  });
}
