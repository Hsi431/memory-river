import type { EnumerationPlan } from '@memory-river/core';

import type { LocomoConversation } from './locomo.js';

export interface EnumerationPlanBuildResult {
  plan?: EnumerationPlan;
  plannerSkipped: boolean;
  fallbackUsed: boolean;
}

const SHARED_MARKERS = [
  'both',
  'share',
  'shared',
  'common',
  ' and ',
  '共同',
  '都',
];

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'both', 'by', 'did', 'do', 'does',
  'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'in', 'is',
  'it', 'its', 'of', 'on', 'or', 'she', 'share', 'shared', 'that', 'the',
  'their', 'them', 'they', 'to', 'was', 'were', 'what', 'when', 'where',
  'which', 'who', 'whom', 'whose', 'why', 'with',
]);

function normalize(text: string): string {
  return text.toLocaleLowerCase();
}

function escapedRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripPossessive(text: string): string {
  return text.trim().replace(/(?:'s|’s)$/i, '');
}

function questionContains(question: string, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[\p{L}\p{N}_ ]+$/u.test(trimmed)) {
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapedRegExp(trimmed)}([^\\p{L}\\p{N}_]|$)`, 'iu')
      .test(question);
  }
  return normalize(question).includes(normalize(trimmed));
}

function hasSharedMarker(question: string): boolean {
  const normalized = normalize(question);
  return SHARED_MARKERS.some(marker => normalized.includes(marker));
}

function addLexiconEntry(entries: Set<string>, value: string): void {
  const stripped = stripPossessive(value).replace(/\s+/g, ' ').trim();
  if (stripped.length >= 2) entries.add(stripped);
}

function quotedSpans(text: string): string[] {
  return [...text.matchAll(/["'“”‘’]([^"'“”‘’]{2,80})["'“”‘’]/g)]
    .map(match => match[1]);
}

function capitalizedSpans(text: string): string[] {
  return [...text.matchAll(/\b[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|[A-Z]\.)){0,3}/g)]
    .map(match => match[0]);
}

function nameLikeSpans(text: string): string[] {
  return [...text.matchAll(/[\p{Script=Han}]{2,8}/gu)]
    .map(match => match[0]);
}

function buildEntityLexicon(question: string, conversation: LocomoConversation): string[] {
  const entries = new Set<string>();
  addLexiconEntry(entries, conversation.speakerA);
  addLexiconEntry(entries, conversation.speakerB);

  for (const session of conversation.sessions) {
    for (const turn of session.turns) {
      addLexiconEntry(entries, turn.speaker);
      for (const span of quotedSpans(turn.text)) addLexiconEntry(entries, span);
      for (const span of capitalizedSpans(turn.text)) addLexiconEntry(entries, span);
    }
  }

  for (const span of quotedSpans(question)) addLexiconEntry(entries, span);
  for (const span of capitalizedSpans(question)) addLexiconEntry(entries, span);
  for (const span of nameLikeSpans(question)) addLexiconEntry(entries, span);

  return [...entries].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function pickQuestionEntity(question: string, lexicon: string[], excluded: Set<string>): string | null {
  const normalizedQuestion = normalize(question);
  const exact = lexicon.find(entry => !excluded.has(normalize(entry)) && questionContains(question, entry));
  if (exact) return exact;

  const questionTokens = new Set(
    normalizedQuestion
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(token => token.length >= 3 && !STOPWORDS.has(token)),
  );
  let best: { entry: string; score: number } | null = null;
  for (const entry of lexicon) {
    if (excluded.has(normalize(entry))) continue;
    const tokens = normalize(entry).split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    const score = tokens.filter(token => questionTokens.has(token)).length;
    if (score > 0 && (!best || score > best.score || entry.length > best.entry.length)) {
      best = { entry, score };
    }
  }
  return best?.entry ?? null;
}

function relationText(question: string, anchors: string[]): string | undefined {
  const anchorSet = new Set(anchors.map(anchor => normalize(anchor)));
  const words = question
    .split(/[^\p{L}\p{N}_]+/u)
    .map(word => stripPossessive(word))
    .filter(word => word.length > 0)
    .filter(word => !STOPWORDS.has(normalize(word)))
    .filter(word => !anchorSet.has(normalize(word)));
  return words.length > 0 ? words.join(' ') : undefined;
}

export function buildEnumerationPlan(
  question: string,
  conversation: LocomoConversation,
): EnumerationPlanBuildResult {
  const speakerAnchors = [conversation.speakerA, conversation.speakerB]
    .filter(speaker => questionContains(question, speaker));
  if (speakerAnchors.length > 0) {
    const setMode = speakerAnchors.length === 2 && hasSharedMarker(question) ? 'intersection' : 'union';
    const plan: EnumerationPlan = {
      anchors: speakerAnchors,
      setMode,
      relationText: relationText(question, speakerAnchors),
      direction: 'out',
    };
    return { plan, plannerSkipped: false, fallbackUsed: false };
  }

  const excluded = new Set([normalize(conversation.speakerA), normalize(conversation.speakerB)]);
  const anchor = pickQuestionEntity(question, buildEntityLexicon(question, conversation), excluded);
  if (!anchor) return { plannerSkipped: true, fallbackUsed: false };

  const plan: EnumerationPlan = {
    anchors: [anchor],
    setMode: 'union',
    relationText: relationText(question, [anchor]),
    direction: 'out',
  };
  return { plan, plannerSkipped: false, fallbackUsed: true };
}
