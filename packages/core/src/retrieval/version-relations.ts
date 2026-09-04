import type { MemorySearchResult, MemoryVersionRelation } from '../types.js';
import { getEffectiveSlotSubject } from '../util/slot-subject.js';

type Metadata = Record<string, unknown>;

function parseMetadata(value: unknown): Metadata {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Metadata;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Metadata
      : {};
  } catch {
    return {};
  }
}

function references(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function temporalTimestamp(metadata: Metadata): number | null {
  return parseTimestamp(metadata.lastTimestamp) ?? parseTimestamp(metadata.firstTimestamp);
}

function hasPath(graph: Array<Set<number>>, from: number, to: number): boolean {
  const visited = new Set<number>([from]);
  const pending = [from];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const next of graph[current]) {
      if (next === to) return true;
      if (!visited.has(next)) {
        visited.add(next);
        pending.push(next);
      }
    }
  }
  return false;
}

function chooseNewerId(
  candidates: number[],
  oldIndex: number,
  lineage: Array<Set<number>>,
  timestamps: Array<number | null>,
  results: MemorySearchResult[],
): string {
  const lineageCandidates = candidates.filter((candidate) => (
    hasPath(lineage, candidate, oldIndex) && !hasPath(lineage, oldIndex, candidate)
  ));
  const usableCandidates = lineageCandidates.length > 0 ? lineageCandidates : candidates;
  if (lineageCandidates.length === 0) {
    const timestamped = usableCandidates.filter((candidate) => timestamps[candidate] !== null);
    if (timestamped.length > 0) {
      return results[timestamped.reduce((best, candidate) => (
        timestamps[candidate]! > timestamps[best]! ? candidate : best
      ), timestamped[0])].entry.id;
    }
  }
  return results[usableCandidates[0]].entry.id;
}

/**
 * Annotate older versions that are also present in this retrieval result set.
 * The returned array keeps the input order and length; the input is not mutated.
 */
export function annotateVersionRelations(results: MemorySearchResult[]): MemorySearchResult[] {
  if (results.length < 2) return results;

  const indexById = new Map(results.map((result, index) => [result.entry.id, index]));
  const componentParent = results.map((_, index) => index);
  const lineage: Array<Set<number>> = results.map(() => new Set<number>());

  const find = (index: number): number => {
    let root = index;
    while (componentParent[root] !== root) root = componentParent[root];
    while (componentParent[index] !== index) {
      const next = componentParent[index];
      componentParent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) componentParent[rightRoot] = leftRoot;
  };
  const addLineage = (newerId: string, olderId: string): void => {
    const newer = indexById.get(newerId);
    const older = indexById.get(olderId);
    if (newer === undefined || older === undefined || newer === older) return;
    union(newer, older);
    lineage[newer].add(older);
  };

  const metadata = results.map(result => parseMetadata(result.entry.metadata));
  results.forEach((result, index) => {
    if (typeof result.entry.parentId === 'string') {
      addLineage(result.entry.id, result.entry.parentId);
    }
    for (const newerId of references(metadata[index].supersededBy)) {
      addLineage(newerId, result.entry.id);
    }
    for (const olderId of references(metadata[index].supersedes)) {
      addLineage(result.entry.id, olderId);
    }
  });

  const slotSubjectGroups = new Map<string, number>();
  results.forEach((result, index) => {
    const slotKey = result.entry.slotKey;
    const subject = getEffectiveSlotSubject(metadata[index]);
    if (typeof slotKey !== 'string' || slotKey.length === 0 || subject === null) return;
    const groupKey = `${slotKey}\u0000${subject}`;
    const previous = slotSubjectGroups.get(groupKey);
    if (previous === undefined) slotSubjectGroups.set(groupKey, index);
    else union(previous, index);
  });

  const timestamps = metadata.map(temporalTimestamp);
  const newerCandidates = results.map(() => [] as number[]);
  for (let left = 0; left < results.length; left++) {
    for (let right = left + 1; right < results.length; right++) {
      if (find(left) !== find(right)) continue;

      const leftToRight = hasPath(lineage, left, right);
      const rightToLeft = hasPath(lineage, right, left);
      if (leftToRight === rightToLeft) {
        if (leftToRight) continue;
        const leftTimestamp = timestamps[left];
        const rightTimestamp = timestamps[right];
        if (leftTimestamp === null || rightTimestamp === null || leftTimestamp === rightTimestamp) continue;
        if (leftTimestamp > rightTimestamp) newerCandidates[right].push(left);
        else newerCandidates[left].push(right);
      } else if (leftToRight) {
        newerCandidates[right].push(left);
      } else {
        newerCandidates[left].push(right);
      }
    }
  }

  const relationByIndex = new Map<number, MemoryVersionRelation>();
  newerCandidates.forEach((candidates, oldIndex) => {
    if (candidates.length === 0) return;
    relationByIndex.set(oldIndex, {
      isOlder: true,
      newerId: chooseNewerId(candidates, oldIndex, lineage, timestamps, results),
    });
  });

  return results.map((result, index) => {
    const versionRelation = relationByIndex.get(index);
    return versionRelation ? { ...result, versionRelation } : result;
  });
}

export interface VersionRelationGroup {
  primary: MemorySearchResult;
  history: MemorySearchResult[];
}

function recencyTimestamp(result: MemorySearchResult): number | null {
  const timestamp = temporalTimestamp(parseMetadata(result.entry.metadata));
  if (timestamp !== null) return timestamp;
  if (typeof result.entry.updatedAt === 'number' && Number.isFinite(result.entry.updatedAt)) {
    return result.entry.updatedAt;
  }
  if (typeof result.entry.createdAt === 'number' && Number.isFinite(result.entry.createdAt)) {
    return result.entry.createdAt;
  }
  return null;
}

/**
 * Group the relationships already annotated by annotateVersionRelations.
 * This consumes the established relation output and does not re-run relation detection.
 */
export function groupVersionRelations(results: MemorySearchResult[]): VersionRelationGroup[] {
  if (results.length < 2) return [];

  const indexById = new Map(results.map((result, index) => [result.entry.id, index]));
  const parent = results.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  results.forEach((result, index) => {
    const relation = result.versionRelation;
    if (!relation?.isOlder) return;
    const newerIndex = indexById.get(relation.newerId);
    if (newerIndex !== undefined && newerIndex !== index) union(index, newerIndex);
  });

  const membersByRoot = new Map<number, number[]>();
  results.forEach((_, index) => {
    const root = find(index);
    const members = membersByRoot.get(root) ?? [];
    members.push(index);
    membersByRoot.set(root, members);
  });

  const groups: Array<{ firstIndex: number; group: VersionRelationGroup }> = [];
  for (const members of membersByRoot.values()) {
    if (members.length < 2) continue;
    const hasRelation = members.some(index => {
      const relation = results[index].versionRelation;
      return relation?.isOlder && indexById.has(relation.newerId);
    });
    if (!hasRelation) continue;

    const primaryCandidates = members.filter(index => !results[index].versionRelation?.isOlder);
    const candidatePool = primaryCandidates.length > 0 ? primaryCandidates : members;
    const primaryIndex = candidatePool.reduce((best, candidate) => {
      const bestTimestamp = recencyTimestamp(results[best]);
      const candidateTimestamp = recencyTimestamp(results[candidate]);
      if (bestTimestamp === null) return candidateTimestamp === null ? best : candidate;
      if (candidateTimestamp === null) return best;
      return candidateTimestamp > bestTimestamp ? candidate : best;
    }, candidatePool[0]);

    const history = members
      .filter(index => index !== primaryIndex)
      .sort((left, right) => {
        const leftTimestamp = recencyTimestamp(results[left]);
        const rightTimestamp = recencyTimestamp(results[right]);
        if (leftTimestamp === null) return rightTimestamp === null ? left - right : 1;
        if (rightTimestamp === null) return -1;
        return rightTimestamp - leftTimestamp || left - right;
      })
      .map(index => results[index]);
    groups.push({
      firstIndex: Math.min(...members),
      group: { primary: results[primaryIndex], history },
    });
  }

  return groups.sort((left, right) => left.firstIndex - right.firstIndex).map(item => item.group);
}
