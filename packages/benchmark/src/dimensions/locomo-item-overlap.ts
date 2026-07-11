import { createGeminiJudge, type GeminiJudge } from '../harness/gemini-llm.js';

export interface ItemMatcherResult {
  present: boolean;
  span: string;
  parse_failure: boolean;
}

export interface ItemOverlapOptions {
  goldItemsOverride?: string[];
  matcher?: ItemMatcher;
  judge?: Pick<GeminiJudge, 'generate'>;
}

export type ItemMatcher = (
  input: {
    question: string;
    goldItem: string;
    answer: string;
  },
) => Promise<ItemMatcherResult>;

export interface LocomoItemOverlapResult {
  goldItems: string[];
  hitItems: string[];
  uncertainItems: string[];
  matcher_uncertain_items: string[];
  extras: string[];
  itemRecall: number | null;
  itemPrecision: number | null;
  itemF1: number | null;
}

const COMMON_TOKENS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'he',
  'her',
  'him',
  'his',
  'i',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'she',
  'the',
  'their',
  'them',
  'they',
  'to',
  'was',
  'we',
  'with',
  'you',
]);

export function extractGoldItems(goldAnswer: string, override?: string[]): string[] {
  if (override) return [...override];
  return splitListItems(goldAnswer);
}

export function exactSubstringPrepass(item: string, answer: string): boolean {
  const normalizedItem = normalizeWhitespace(item);
  if (!canUseSubstringPrepass(normalizedItem)) return false;
  return boundedIncludes(answer, normalizedItem);
}

export async function scoreLocomoItemOverlap(
  question: string,
  goldAnswer: string,
  answer: string,
  options: ItemOverlapOptions = {},
): Promise<LocomoItemOverlapResult> {
  const goldItems = extractGoldItems(goldAnswer, options.goldItemsOverride);
  const matcher = options.matcher ?? createGeminiItemMatcher(options.judge ?? createGeminiJudge());
  const hitItems: string[] = [];
  const uncertainItems: string[] = [];

  for (const goldItem of goldItems) {
    if (exactSubstringPrepass(goldItem, answer)) {
      hitItems.push(goldItem);
      continue;
    }
    const verdict = await matcher({ question, goldItem, answer });
    if (isMatcherUncertain(verdict)) {
      uncertainItems.push(goldItem);
    } else if (verdict.present) {
      hitItems.push(goldItem);
    }
  }

  const extras = await findExtras({ question, answer, goldItems, matcher });
  const denominator = goldItems.length - uncertainItems.length;
  const itemRecall = denominator > 0 ? hitItems.length / denominator : null;
  const itemPrecision = hitItems.length + extras.length > 0
    ? hitItems.length / (hitItems.length + extras.length)
    : null;
  const itemF1 = itemRecall !== null && itemPrecision !== null && itemRecall + itemPrecision > 0
    ? 2 * itemRecall * itemPrecision / (itemRecall + itemPrecision)
    : null;

  return {
    goldItems,
    hitItems,
    uncertainItems,
    matcher_uncertain_items: uncertainItems,
    extras,
    itemRecall,
    itemPrecision,
    itemF1,
  };
}

export function createGeminiItemMatcher(
  judge: Pick<GeminiJudge, 'generate'> = createGeminiJudge(),
): ItemMatcher {
  return async ({ question, goldItem, answer }) => {
    const raw = await judge.generate(
      `You are a per-item matcher for a list-answer benchmark.\n` +
      `Decide ONLY whether the single GOLD ITEM's meaning is stated in the CANDIDATE ANSWER.\n` +
      `- present=true if the answer states this item, even in different words, a paraphrase, or another language (e.g. "陶藝" matches "pottery"). Set span to the exact evidence text from the answer.\n` +
      `- present=false if the answer does not state this item. A clean absence is a normal, expected result — do NOT abstain just because the answer omits it.\n` +
      `- parse_failure=true ONLY if the item is genuinely undecidable after careful reading. Differing wording is NOT a reason to abstain.\n` +
      `Do not judge whether the overall answer is correct. Do not credit items the answer never mentions.\n` +
      `Return only JSON with this exact shape: {"present": boolean, "span": string, "parse_failure": boolean}\n\n` +
      `QUESTION: ${question}\n` +
      `GOLD ITEM: ${goldItem}\n` +
      `CANDIDATE ANSWER: ${answer}`,
    );
    return parseMatcherResult(raw);
  };
}

export function parseMatcherResult(raw: string): ItemMatcherResult {
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as Partial<ItemMatcherResult>;
    const present = parsed.present === true;
    const span = typeof parsed.span === 'string' ? parsed.span.trim() : '';
    const parseFailure = parsed.parse_failure === true;
    if (parseFailure || (present && span.length === 0)) {
      return { present: false, span, parse_failure: true };
    }
    if (parsed.present !== true && parsed.present !== false) {
      return { present: false, span: '', parse_failure: true };
    }
    return { present, span, parse_failure: false };
  } catch {
    return { present: false, span: '', parse_failure: true };
  }
}

function splitListItems(input: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      current += char;
      continue;
    }
    if (quote && char === quote) {
      quote = null;
      current += char;
      continue;
    }
    if (!quote && (char === ',' || char === ';')) {
      pushItem(items, current);
      current = '';
      continue;
    }
    current += char;
  }
  pushItem(items, current);
  return dedupe(items);
}

function pushItem(items: string[], raw: string): void {
  const trimmed = normalizeWhitespace(raw)
    .replace(/^["']|["']$/g, '')
    .trim();
  if (trimmed.length > 0) items.push(trimmed);
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function canUseSubstringPrepass(item: string): boolean {
  if (item.length <= 3) return false;
  if (/^\d+(?:[./-]\d+)*$/.test(item)) return false;
  if (COMMON_TOKENS.has(item.toLocaleLowerCase())) return false;
  return true;
}

export function boundedIncludes(haystack: string, needle: string): boolean {
  const escaped = escapeRegExp(needle).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(haystack);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return trimmed;
  return trimmed.slice(start, end + 1);
}

function isMatcherUncertain(verdict: ItemMatcherResult): boolean {
  return verdict.parse_failure || (verdict.present && verdict.span.trim().length === 0);
}

async function findExtras(
  input: {
    question: string;
    answer: string;
    goldItems: string[];
    matcher: ItemMatcher;
  },
): Promise<string[]> {
  const answerItems = splitListItems(input.answer);
  const extras: string[] = [];
  for (const answerItem of answerItems) {
    let matchedGold = false;
    for (const goldItem of input.goldItems) {
      if (exactSubstringPrepass(goldItem, answerItem)) {
        matchedGold = true;
        break;
      }
      const verdict = await input.matcher({
        question: input.question,
        goldItem,
        answer: answerItem,
      });
      if (!isMatcherUncertain(verdict) && verdict.present) {
        matchedGold = true;
        break;
      }
    }
    if (!matchedGold) extras.push(answerItem);
  }
  return extras;
}
