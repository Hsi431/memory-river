import type { SubsystemEffectivenessEvent } from '../types.js';

export interface InjectedMemory {
  memoryId: string;
  snippet: string;
  source: 'autoRecall' | 'gwm_keyword' | 'manual_recall';
  injectedAt: number;
  viaHook?: boolean;
  hookKeyword?: string;
}

export interface AttributionResult {
  memoryId: string;
  outcome: 'used' | 'partial' | 'unused';
  score: number;
  method: 'ngram' | 'embedding' | 'skipped' | 'ngram_fallback';
  injectedSnippet: string;
  outputSnippet: string;
  fallbackReason?: string;
}

export interface SubsystemReporter {
  recordEvent(event: Partial<SubsystemEffectivenessEvent>): Promise<void> | void;
}

export interface EmbeddingProvider {
  embed(text: string, mode?: 'store' | 'query'): Promise<number[]>;
}

const NGRAM_USED_THRESHOLD = 0.50;
const EMBEDDING_USED_THRESHOLD = 0.75;
const EMBEDDING_PARTIAL_THRESHOLD = 0.55;
const MIN_OUTPUT_LEN = 50;

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function normalizeForNgram(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：,.!?;:"'`~()[\]{}<>《》「」『』【】]/g, '');
}

function makeNgrams(text: string, size: number): string[] {
  if (text.length < size) return [];
  const grams: string[] = [];
  for (let i = 0; i <= text.length - size; i++) {
    grams.push(text.slice(i, i + size));
  }
  return grams;
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class CausalAttributionEngine {
  constructor(
    private subsystemReporter: SubsystemReporter,
    private embedder?: EmbeddingProvider,
  ) {
    if (!embedder) {
      console.warn('[causal-attribution] embedder not provided, ' +
        'embedding fallback disabled — only ngram >= USED_THRESHOLD ' +
        'will mark used, all others will be unused');
    }
  }

  attributeMemoriesAsync(
    injected: InjectedMemory[],
    outputText: string,
    requestId: string,
  ): void {
    setImmediate(() => {
      void this.attributeMemories(injected, outputText, requestId).catch((err: any) => {
        console.error('[causal-attribution] failed', err);
      });
    });
  }

  private async attributeMemories(
    injected: InjectedMemory[],
    outputText: string,
    requestId: string,
  ): Promise<void> {
    if (!injected || injected.length === 0) return;

    if (!outputText || outputText.length < MIN_OUTPUT_LEN) {
      for (const mem of injected) {
        try {
          await this.subsystemReporter.recordEvent({
            subsystem: 'causal',
            event: 'memory_attributed',
            outcome: 'skipped',
            entityId: mem.memoryId,
            relatedId: mem.memoryId,
            score: 0,
            count: 1,
            durationMs: 0,
            metadata: {
              method: 'skipped',
              source: mem.source,
              requestId,
              reason: 'output_too_short',
              outputLen: outputText?.length ?? 0,
              viaHook: mem.viaHook ?? false,
              hookKeyword: mem.hookKeyword ?? null,
            },
          });
        } catch (err) {
          console.error('[causal-attribution] short-output skip write failed', {
            memoryId: mem.memoryId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }

    for (const mem of injected) {
      try {
        const result = await this.scoreOne(mem, outputText);
        await this.subsystemReporter.recordEvent({
          subsystem: 'causal',
          event: 'memory_attributed',
          outcome: result.outcome,
          entityId: mem.memoryId,
          relatedId: mem.memoryId,
          score: result.score,
          count: 1,
          durationMs: 0,
          metadata: {
            method: result.method,
            source: mem.source,
            requestId,
            injectedSnippet: result.injectedSnippet,
            outputSnippet: result.outputSnippet,
            outputLen: outputText.length,
            fallbackReason: result.fallbackReason,
            viaHook: mem.viaHook ?? false,
            hookKeyword: mem.hookKeyword ?? null,
          },
        });
      } catch (err) {
        console.error('[causal-attribution] memory attribution failed', {
          memoryId: mem.memoryId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async scoreOne(mem: InjectedMemory, outputText: string): Promise<AttributionResult> {
    const injectedSnippet = truncateText(mem.snippet, 80);
    if (outputText.length < MIN_OUTPUT_LEN) {
      return {
        memoryId: mem.memoryId,
        outcome: 'unused',
        score: 0,
        method: 'ngram',
        injectedSnippet,
        outputSnippet: '',
      };
    }

    const ngramScore = this.ngramOverlap(mem.snippet, outputText);
    if (ngramScore >= NGRAM_USED_THRESHOLD) {
      return {
        memoryId: mem.memoryId,
        outcome: 'used',
        score: ngramScore,
        method: 'ngram',
        injectedSnippet,
        outputSnippet: this.findOutputSnippet(mem.snippet, outputText),
      };
    }
    if (!this.embedder) {
      return {
        memoryId: mem.memoryId,
        outcome: 'unused',
        score: ngramScore,
        method: 'ngram',
        injectedSnippet,
        outputSnippet: '',
      };
    }

    try {
      const embeddingScore = await this.cosineSim(mem.snippet, outputText);
      return {
        memoryId: mem.memoryId,
        outcome: this.classifyByEmbedding(embeddingScore),
        score: embeddingScore,
        method: 'embedding',
        injectedSnippet,
        outputSnippet: embeddingScore >= EMBEDDING_PARTIAL_THRESHOLD
          ? truncateText(outputText, 80)
          : '',
      };
    } catch (err) {
      console.error('[causal-attribution] embedding fallback failed', {
        memoryId: mem.memoryId,
        error: err instanceof Error ? err.message : String(err),
      });
      const fallbackReason = err instanceof Error ? err.message : String(err);
      return {
        memoryId: mem.memoryId,
        outcome: 'unused',
        score: ngramScore,
        method: 'ngram_fallback',
        injectedSnippet,
        outputSnippet: '',
        fallbackReason,
      };
    }
  }

  private ngramOverlap(a: string, b: string): number {
    const inj = normalizeForNgram(a);
    const out = normalizeForNgram(b);
    const injectedNgrams = new Set([
      ...makeNgrams(inj, 2),
      ...makeNgrams(inj, 3),
      ...makeNgrams(inj, 4),
    ]);
    if (injectedNgrams.size === 0) return 0;

    const outputNgrams = new Set([
      ...makeNgrams(out, 2),
      ...makeNgrams(out, 3),
      ...makeNgrams(out, 4),
    ]);
    let overlap = 0;
    for (const gram of injectedNgrams) {
      if (outputNgrams.has(gram)) overlap++;
    }
    return overlap / injectedNgrams.size;
  }

  private async cosineSim(a: string, b: string): Promise<number> {
    const injected = truncateText(a, 200);
    const output = truncateText(b, 500);
    const [aVec, bVec] = await Promise.all([
      this.embedder!.embed(injected, 'query'),
      this.embedder!.embed(output, 'query'),
    ]);
    return cosine(aVec, bVec);
  }

  private classifyByEmbedding(score: number): 'used' | 'partial' | 'unused' {
    if (score >= EMBEDDING_USED_THRESHOLD) return 'used';
    if (score >= EMBEDDING_PARTIAL_THRESHOLD) return 'partial';
    return 'unused';
  }

  private findOutputSnippet(injected: string, output: string): string {
    const inj = normalizeForNgram(injected);
    const out = normalizeForNgram(output);
    const grams = [...makeNgrams(inj, 4), ...makeNgrams(inj, 3), ...makeNgrams(inj, 2)];
    const hit = grams.find(gram => out.includes(gram));
    if (!hit) return '';
    const rawIndex = output.toLowerCase().indexOf(hit.slice(0, Math.min(4, hit.length)));
    if (rawIndex < 0) return truncateText(output, 80);
    return truncateText(output.slice(Math.max(0, rawIndex - 20), rawIndex + 60), 80);
  }
}
