import type { WorkspaceMember, Container } from '../types';

export interface FilterResult {
  /** Set of container IDs to show (source-level or partial) */
  visibleContainerIds: Set<string>;
  /** Map: containerId → Set of sessionIds to show (or "all") */
  visibleSessions: Map<string, Set<string> | 'all'>;
  /** Offline source members with no live container match */
  offlineMembers: Array<WorkspaceMember & { type: 'source' }>;
}

export function filterWorkspace(
  members: WorkspaceMember[],
  liveContainers: Container[],
): FilterResult {
  const visibleContainerIds = new Set<string>();
  const visibleSessions = new Map<string, Set<string> | 'all'>();
  const offlineMembers: Array<WorkspaceMember & { type: 'source' }> = [];

  const liveContainerIds = new Set(liveContainers.map((c) => c.id));

  for (const member of members) {
    if (member.type === 'source') {
      if (liveContainerIds.has(member.sourceId)) {
        visibleContainerIds.add(member.sourceId);
        visibleSessions.set(member.sourceId, 'all');
      } else {
        offlineMembers.push(member);
      }
    } else if (member.type === 'session') {
      visibleContainerIds.add(member.sourceId);
      const existing = visibleSessions.get(member.sourceId);
      if (existing === 'all') continue; // source-level membership already covers it
      if (existing) {
        existing.add(member.sessionId);
      } else {
        visibleSessions.set(member.sourceId, new Set([member.sessionId]));
      }
    }
  }

  return { visibleContainerIds, visibleSessions, offlineMembers };
}
