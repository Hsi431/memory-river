const COMMON_SINGLE_CJK_TOKENS = new Set([
  '的',
  '了',
  '是',
  '在',
  '有',
  '他',
  '她',
  '我',
  '你',
  '不',
  '一',
]);

export interface KeywordSearchCandidate<T> {
  value: T;
  text: string;
  timestamp?: number | string | Date | null;
}

export function buildKeywordSearchTerms(keyword: string): string[] {
  return [...new Set(
    keyword
      .split(/\s+/)
      .map(token => token.trim().toLowerCase())
      .filter(token => token.length > 0)
      .filter(token => !/^[\x00-\x7f]$/.test(token))
      .filter(token => !COMMON_SINGLE_CJK_TOKENS.has(token)),
  )];
}

export function countKeywordMatches(text: string, keyword: string): number {
  const normalized = text.toLowerCase();
  return buildKeywordSearchTerms(keyword)
    .reduce((count, token) => count + Number(normalized.includes(token)), 0);
}

export function matchesKeywordSearch(text: string, keyword: string): boolean {
  return countKeywordMatches(text, keyword) > 0;
}

export function rankKeywordMatches<T>(
  candidates: readonly KeywordSearchCandidate<T>[],
  keyword: string,
  limit = Number.POSITIVE_INFINITY,
): T[] {
  const terms = buildKeywordSearchTerms(keyword);
  if (terms.length === 0 || limit <= 0) return [];

  return candidates
    .map((candidate, index) => {
      const normalized = candidate.text.toLowerCase();
      const matchCount = terms.reduce(
        (count, term) => count + Number(normalized.includes(term)),
        0,
      );
      return {
        ...candidate,
        index,
        matchCount,
        timestampMs: normalizeTimestamp(candidate.timestamp),
      };
    })
    .filter(candidate => candidate.matchCount > 0)
    .sort((a, b) =>
      b.matchCount - a.matchCount
      || b.timestampMs - a.timestampMs
      || a.index - b.index)
    .slice(0, limit)
    .map(candidate => candidate.value);
}

function normalizeTimestamp(timestamp: number | string | Date | null | undefined): number {
  if (typeof timestamp === 'number') return Number.isFinite(timestamp) ? timestamp : 0;
  if (timestamp instanceof Date) {
    const value = timestamp.getTime();
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof timestamp === 'string') {
    const numeric = Number(timestamp);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
