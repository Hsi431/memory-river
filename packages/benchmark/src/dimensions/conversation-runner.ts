/**
 * Generic conversation-benchmark runner, shared between locomo and zh-chat.
 *
 * Takes a pre-parsed conversation set in the shared shape and runs the full
 * ingestion → Otter QA → judge → metrics pipeline. Both dimensions call this
 * without any duplication of the ~250-line ingestion+QA loop.
 *
 * Parameterisation strategy (no duplication of ~250 lines):
 *   - ConvQa.category is a string so both numeric (locomo "5") and named
 *     (zh-chat "factual") labels work uniformly.
 *   - An optional gradeQuestion callback in ConvRunnerConfig lets locomo
 *     preserve its category-5 abstention grading without touching the runner.
 *   - zh-chat omits the callback; the generic judge grades every answer.
 *   - All other instrumentation (toolTrace, toolCounts, rehydrateModeMix,
 *     entryIdsAdvertised, emptyRetrieval, capExhausted) is shared verbatim.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { runOtter } from '../agent/otter.js';
import { createGeminiJudge, geminiJudgeAvailable } from '../harness/gemini-llm.js';
import { deepseekApiKey } from '../harness/provider-keys.js';
import type { ToolResultEvent } from '../harness/tool-llm.js';
import {
  concentrationConfigured,
  createRealMemoryRiver,
  type ProviderUsageEvent,
} from '../harness/real-river.js';
import { ollamaHealthy } from '../harness/real-embedder.js';
import { snapshotCacheKey } from '../harness/snapshot-key.js';
import type { BenchmarkResult } from '../report.js';
import type { BenchmarkOptions } from './index.js';
import { createIdxRehydrator } from './locomo-rehydrator.js';

import type { ContextMessage } from '@memory-river/core';

// ─── Shared parsed shapes ────────────────────────────────────────────────────

export interface ConvTurn {
  speaker: string;
  diaId: string;
  text: string;
}

export interface ConvSession {
  index: number;
  dateTime: string;
  turns: ConvTurn[];
  messages: ContextMessage[];
}

export interface ConvQa {
  question: string;
  answer?: string | number;
  evidence: string[];
  /** Category label — numeric string for locomo (e.g. "4", "5"), named for zh-chat */
  category: string;
  sourceIndex?: number;
}

export interface ConvSet {
  sampleId: string;
  sessions: ConvSession[];
  qa: ConvQa[];
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const TOOL_NAMES = [
  'memory_recall',
  'memory_rehydrate',
  'memory_store',
  'gwm_on',
  'gwm_off',
  'gwm_status',
  'gwm_update',
  'skill_save',
  'skill_load',
] as const;


type ToolName = typeof TOOL_NAMES[number];
type ToolCounts = Record<ToolName, number>;

export interface GradeResult {
  correct: boolean;
  parseFailure: boolean;
}

interface QuestionToolTrace {
  name: string;
  args: string;
  resultCount?: number;
  content: string;
}

interface QuestionDetail {
  sampleId: string;
  conversationIndex: number;
  questionIndex: number;
  sourceIndex: number;
  category: string;
  question: string;
  referenceAnswer: string;
  evidence: string[];
  candidateAnswer: string;
  judge: GradeResult;
  capExhausted: boolean;
  emptyRetrieval: boolean;
  entryIdsAdvertised: boolean;
  toolTrace: QuestionToolTrace[];
  toolCounts: ToolCounts;
  wallClockSeconds: number;
  tokens: {
    deepseekAgent: TokenUsage;
    concentrationIngestion: TokenUsageByProvider & { attribution: 'conversation-shared' };
    geminiJudge: TokenUsage;
  };
}

interface TokenUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

interface TokenUsageByProvider extends TokenUsage {
  byProvider: {
    gemini: TokenUsage;
    deepseek: TokenUsage;
  };
}

function emptyToolCounts(): ToolCounts {
  return Object.fromEntries(TOOL_NAMES.map(name => [name, 0])) as ToolCounts;
}

function emptyTokenUsage(): TokenUsage {
  return { calls: 0, promptTokens: 0, completionTokens: 0 };
}

function emptyTokenUsageByProvider(): TokenUsageByProvider {
  return {
    ...emptyTokenUsage(),
    byProvider: {
      gemini: emptyTokenUsage(),
      deepseek: emptyTokenUsage(),
    },
  };
}

function addTokenUsage(target: TokenUsage, usage: TokenUsage): void {
  target.calls += usage.calls;
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
}

function addProviderUsage(target: TokenUsageByProvider, event: ProviderUsageEvent): void {
  const usage = {
    calls: 1,
    promptTokens: event.promptTokens,
    completionTokens: event.completionTokens,
  };
  addTokenUsage(target, usage);
  addTokenUsage(target.byProvider[event.provider], usage);
}

function copyTokenUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}

function copyProviderUsage(usage: TokenUsageByProvider): TokenUsageByProvider {
  return {
    calls: usage.calls,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    byProvider: {
      gemini: copyTokenUsage(usage.byProvider.gemini),
      deepseek: copyTokenUsage(usage.byProvider.deepseek),
    },
  };
}

function averageTokenUsage(usage: TokenUsage, questions: number): TokenUsage {
  if (questions === 0) return emptyTokenUsage();
  return {
    calls: usage.calls / questions,
    promptTokens: usage.promptTokens / questions,
    completionTokens: usage.completionTokens / questions,
  };
}

function truncate(value: string, maxChars = 500): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function serializeArgs(args: Record<string, unknown>): string {
  try {
    return truncate(JSON.stringify(args));
  } catch {
    return truncate(String(args));
  }
}

async function defaultGradeAnswer(
  judge: { generate(prompt: string): Promise<string> },
  qa: ConvQa,
  candidate: string,
): Promise<GradeResult> {
  const verdict = (await judge.generate(
    `Grade whether the candidate answer is correct.\n` +
    `Question: ${qa.question}\nReference answer: ${String(qa.answer ?? '')}\n` +
    `Candidate answer: ${candidate}\n\n` +
    `Accept equivalent wording and concise answers. Reply with exactly YES or NO.`,
  )).trim().toUpperCase();
  if (verdict === 'YES') return { correct: true, parseFailure: false };
  if (verdict === 'NO') return { correct: false, parseFailure: false };
  return { correct: false, parseFailure: true };
}

// ─── Runner config ────────────────────────────────────────────────────────────

export interface ConvRunnerConfig {
  /** Dimension name used for session key prefix and BenchmarkResult.dimension */
  dimensionName: string;
  /**
   * Optional custom grader. Locomo passes one that handles category-5
   * unanswerable questions (abstention check). zh-chat omits it.
   */
  gradeQuestion?: (
    judge: { generate(prompt: string): Promise<string> },
    qa: ConvQa,
    candidate: string,
  ) => Promise<GradeResult>;
}

// ─── Generic runner ───────────────────────────────────────────────────────────

export async function runConversationBenchmark(
  conversations: ConvSet[],
  config: ConvRunnerConfig,
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const { dimensionName, gradeQuestion = defaultGradeAnswer } = config;
  const runStartedAt = Date.now();

  if (!(await ollamaHealthy())) {
    return { dimension: dimensionName, metrics: {}, details: { skipped: 'ollama-unavailable' } };
  }
  if (!concentrationConfigured()) {
    return {
      dimension: dimensionName,
      metrics: {},
      details: { skipped: 'concentration-key-unavailable' },
    };
  }
  const agentApiKey = deepseekApiKey();
  if (!agentApiKey) {
    return {
      dimension: dimensionName,
      metrics: {},
      details: { skipped: 'deepseek-agent-key-unavailable' },
    };
  }
  if (!geminiJudgeAvailable()) {
    return {
      dimension: dimensionName,
      metrics: {},
      details: { skipped: 'gemini-judge-key-unavailable' },
    };
  }

  const slice = conversations.slice(0, options.limit ?? conversations.length);
  const judge = createGeminiJudge();
  const categoryCounts = new Map<string, { correct: number; total: number }>();
  const conversationDetails: Array<Record<string, unknown>> = [];
  const rehydrateModeMix: Record<string, number> = {
    entry_ids: 0,
    keyword: 0,
    time_range: 0,
  };
  let correct = 0;
  let total = 0;
  let toolCalls = 0;
  let questionsUsingRehydrate = 0;
  let capExhaustedCount = 0;
  let emptyRetrievalCount = 0;
  let rehydrateZeroHitCount = 0;
  let judgeParseFailureCount = 0;
  let judgeErrorCount = 0;
  let entryIdsAdvertisedObserved = 0;
  let rehydrateHits = 0;
  let rehydrateCalls = 0;
  const toolTotals = emptyToolCounts();
  const agentUsage = emptyTokenUsage();
  const ingestionUsage = emptyTokenUsageByProvider();
  const judgeUsage = emptyTokenUsage();
  let ingestionWallClockSeconds = 0;
  let questionWallClockSeconds = 0;

  function buildResult(): BenchmarkResult {
    const categoryAccuracy: Record<string, {
      correct: number;
      total: number;
      accuracy: number;
    }> = {};
    const metrics: Record<string, number> = {
      answer_accuracy: total > 0 ? correct / total : 0,
      rehydrate_hit_rate: rehydrateCalls > 0 ? rehydrateHits / rehydrateCalls : 0,
      entry_ids_advertised_observed: entryIdsAdvertisedObserved,
    };
    for (const [category, counts] of [...categoryCounts.entries()].sort()) {
      const accuracy = counts.total > 0 ? counts.correct / counts.total : 0;
      categoryAccuracy[category] = { ...counts, accuracy };
      metrics[`category_${category}_accuracy`] = accuracy;
    }
    const totalWallClockSeconds = (Date.now() - runStartedAt) / 1000;
    return {
      dimension: dimensionName,
      metrics,
      details: {
        conversations: conversationDetails,
        categoryAccuracy,
        telemetry: {
          avgToolCallsPerQuestion: total > 0 ? toolCalls / total : 0,
          rehydrateModeMix,
          rehydrateHitRate: rehydrateCalls > 0 ? rehydrateHits / rehydrateCalls : 0,
          questionsUsingRehydratePct: total > 0 ? (questionsUsingRehydrate / total) * 100 : 0,
          capExhaustedCount,
          emptyRetrievalCount,
          rehydrateZeroHitCount,
          entryIdsAdvertisedObserved,
          judgeParseFailureCount,
          judgeErrorCount,
          toolTotals,
        },
        instrumentation: {
          questionsCompleted: total,
          tokens: {
            deepseekAgent: copyTokenUsage(agentUsage),
            concentrationIngestion: copyProviderUsage(ingestionUsage),
            geminiJudge: copyTokenUsage(judgeUsage),
          },
          tokensPerQuestion: {
            deepseekAgent: averageTokenUsage(agentUsage, total),
            concentrationIngestion: averageTokenUsage(ingestionUsage, total),
            geminiJudge: averageTokenUsage(judgeUsage, total),
          },
          wallClockSeconds: {
            total: totalWallClockSeconds,
            questions: questionWallClockSeconds,
            ingestion: ingestionWallClockSeconds,
            perQuestionAverage: total > 0 ? totalWallClockSeconds / total : 0,
          },
        },
        agent: {
          model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
        },
        judge: {
          model: judge.model,
          stats: { ...judge.stats },
        },
      },
    };
  }

  // Resumable answer cache: set MR_ANSWER_CACHE=<path.jsonl> to make long runs crash-safe.
  // Each answered question (agent answer + judge grade) is appended immediately; a re-run with the
  // same cache file skips already-answered questions, so a mid-run death (e.g. balance exhausted)
  // loses at most the in-flight question. Key is run-order-stable (seeded sampling => same questions).
  type CachedAnswer = {
    key: string;
    question: string;
    result: Awaited<ReturnType<typeof runOtter>>;
    grade: GradeResult;
    toolResults: ToolResultEvent[];
    questionSeconds: number;
    judgeError: boolean;
  };
  const answerCachePath = process.env.MR_ANSWER_CACHE;
  // Resume skips runOtter for cached questions; without read-only, runOtter mutates the shared
  // per-conversation river (memory_store/gwm/skill_*), so a resumed run's UNcached questions would
  // see different river state than an uninterrupted run and stop being equivalent. Fail fast.
  if (answerCachePath && process.env.MR_OTTER_READONLY !== '1') {
    throw new Error('MR_ANSWER_CACHE requires MR_OTTER_READONLY=1 (resume correctness: cached questions skip the agent, so mutating tools must be disabled).');
  }
  const answerCache = new Map<string, CachedAnswer>();
  if (answerCachePath && fs.existsSync(answerCachePath)) {
    for (const line of fs.readFileSync(answerCachePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as CachedAnswer;
        if (entry?.key) answerCache.set(entry.key, entry);
      } catch { /* skip malformed/partial trailing line */ }
    }
    console.log(`[answer-cache] resuming: ${answerCache.size} cached answers loaded from ${answerCachePath}`);
  }

  for (const [conversationIndex, conversation] of slice.entries()) {
    const conversationIngestionUsage = emptyTokenUsageByProvider();
    const snapshotPath = options.snapshotDir
      ? path.join(options.snapshotDir, snapshotCacheKey(conversation))
      : undefined;
    const manifestPath = snapshotPath ? path.join(snapshotPath, 'manifest.json') : undefined;
    const canRestore = !!manifestPath && !options.rebuildSnapshot && fs.existsSync(manifestPath);
    const real = await createRealMemoryRiver(event => {
      addProviderUsage(conversationIngestionUsage, event);
      addProviderUsage(ingestionUsage, event);
    }, canRestore ? snapshotPath : undefined);
    const convKey = `${dimensionName}-${conversation.sampleId}`;
    const sessionKeys = conversation.sessions.map(
      session => `${convKey}-s${session.index}`,
    );
    let compactedSessions = 0;
    let memoryCount = 0;
    try {
      let conversationIngestionSeconds = 0;
      if (canRestore) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath!, 'utf8')) as {
          memoryCount: number;
          compactedSessions: number;
        };
        memoryCount = manifest.memoryCount;
        compactedSessions = manifest.compactedSessions;
      } else {
        const ingestionStartedAt = Date.now();
        await real.river.archiveTranscript(
          { sessionKey: convKey, sessionId: convKey },
          conversation.sessions.flatMap(session => session.messages),
        );
        for (const [index, session] of conversation.sessions.entries()) {
          const result = await real.forceCompactSession(sessionKeys[index], session.messages);
          if (result.compacted) compactedSessions++;
          memoryCount = result.memoryCount;
        }
        conversationIngestionSeconds = (Date.now() - ingestionStartedAt) / 1000;
        if (snapshotPath && manifestPath) {
          real.snapshotTo(snapshotPath);
          fs.writeFileSync(
            manifestPath,
            JSON.stringify({ memoryCount, compactedSessions }),
            'utf8',
          );
        }
      }
      ingestionWallClockSeconds += conversationIngestionSeconds;

      const rehydrateById = createIdxRehydrator(
        path.join(real.dataDir, 'transcripts'),
        sessionKeys,
      );

      const categoryFiltered = options.category === undefined
        ? conversation.qa
        : conversation.qa.filter(qa => String(qa.category) === String(options.category));
      const questions = options.maxQuestions === undefined
        ? categoryFiltered
        : categoryFiltered.slice(0, options.maxQuestions);
      const questionDetails: QuestionDetail[] = [];
      conversationDetails.push({
        sampleId: conversation.sampleId,
        sessions: conversation.sessions.length,
        compactedSessions,
        memoryCount,
        ingestion: {
          wallClockSeconds: conversationIngestionSeconds,
          tokens: copyProviderUsage(conversationIngestionUsage),
        },
        questions: questionDetails,
      });
      options.onProgress?.(buildResult());

      for (const [questionIndex, qa] of questions.entries()) {
        const questionStartedAt = Date.now();
        const judgeBefore = { ...judge.stats };
        const cacheKey = `${conversationIndex}:${questionIndex}:${qa.sourceIndex ?? questionIndex}`;
        let toolResults: ToolResultEvent[] = [];
        let result: Awaited<ReturnType<typeof runOtter>>;
        let grade: GradeResult;
        let judgeError = false;
        let questionSeconds: number;
        const cachedAnswer = answerCache.get(cacheKey);
        if (cachedAnswer && cachedAnswer.question !== qa.question) {
          // Key hit but the question text differs => stale cache from a different run config.
          // Re-answer rather than serve a wrong cached answer.
          console.warn(`[answer-cache] key ${cacheKey} question mismatch (stale cache?); re-answering.`);
        }
        if (cachedAnswer && cachedAnswer.question === qa.question) {
          // Resume path: reuse the cached agent answer + judge grade, skipping both LLM calls.
          result = cachedAnswer.result;
          toolResults = cachedAnswer.toolResults;
          grade = cachedAnswer.grade;
          judgeError = cachedAnswer.judgeError;
          questionSeconds = cachedAnswer.questionSeconds;
        } else {
          result = await runOtter({
            llm: {
              apiKey: agentApiKey,
              model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
            },
            river: real.river,
            question: qa.question,
            sessionKeys,
            conversationKey: convKey,
            rehydrateById,
            onToolResult(event) {
              toolResults.push(event);
            },
          });
          // A single judge failure (e.g. Gemini 503 after retries) must NOT abort the whole run.
          // Mark the question ungraded, exclude it from totals (accuracy = correct/graded), continue.
          try {
            grade = await gradeQuestion(judge, qa, result.answer);
          } catch (err) {
            judgeError = true;
            judgeErrorCount++;
            grade = { correct: false, parseFailure: false };
            console.error(`[judge] question ungraded (judge error): ${(err as Error)?.message ?? String(err)}`);
          }
          questionSeconds = (Date.now() - questionStartedAt) / 1000;
          // Persist immediately (append-per-question) so a mid-run death loses at most this question.
          if (answerCachePath) {
            fs.appendFileSync(
              answerCachePath,
              JSON.stringify({ key: cacheKey, question: qa.question, result, grade, toolResults, questionSeconds, judgeError }) + '\n',
            );
          }
        }
        questionWallClockSeconds += questionSeconds;
        addTokenUsage(agentUsage, result.usage);
        const questionJudgeUsage = {
          calls: judge.stats.calls - judgeBefore.calls,
          promptTokens: judge.stats.promptTokens - judgeBefore.promptTokens,
          completionTokens: judge.stats.completionTokens - judgeBefore.completionTokens,
        };
        addTokenUsage(judgeUsage, questionJudgeUsage);
        if (!judgeError) {
          const category = categoryCounts.get(qa.category) ?? { correct: 0, total: 0 };
          category.total++;
          total++;
          if (grade.correct) {
            category.correct++;
            correct++;
          }
          if (grade.parseFailure) judgeParseFailureCount++;
          categoryCounts.set(qa.category, category);
        }

        toolCalls += result.trace.length;
        if (result.capExhausted) capExhaustedCount++;
        let usedRehydrate = false;
        let emptyRetrieval = false;
        const questionEntryIdsAdvertised = result.entryIdsAdvertisedInPreamble;
        if (questionEntryIdsAdvertised) entryIdsAdvertisedObserved++;
        const toolCounts = emptyToolCounts();
        for (const call of toolResults) {
          if (call.name in toolCounts) {
            const name = call.name as ToolName;
            toolCounts[name]++;
            toolTotals[name]++;
          }
          if (call.name === 'memory_recall' && call.resultCount === 0) {
            emptyRetrievalCount++;
            emptyRetrieval = true;
          }
          if (call.name === 'memory_rehydrate') {
            usedRehydrate = true;
            rehydrateCalls++;
            const mode = typeof call.args.mode === 'string' ? call.args.mode : '';
            if (mode in rehydrateModeMix) rehydrateModeMix[mode]++;
            if (call.resultCount === 0) {
              rehydrateZeroHitCount++;
            } else {
              rehydrateHits++;
            }
          }
        }
        if (usedRehydrate) questionsUsingRehydrate++;
        questionDetails.push({
          sampleId: conversation.sampleId,
          conversationIndex,
          questionIndex,
          sourceIndex: qa.sourceIndex ?? questionIndex,
          category: qa.category,
          question: qa.question,
          referenceAnswer: String(qa.answer ?? ''),
          evidence: qa.evidence,
          candidateAnswer: result.answer,
          judge: grade,
          capExhausted: result.capExhausted,
          emptyRetrieval,
          entryIdsAdvertised: questionEntryIdsAdvertised,
          toolTrace: toolResults.map(call => ({
            name: call.name,
            args: serializeArgs(call.args),
            ...(call.resultCount === undefined ? {} : { resultCount: call.resultCount }),
            content: truncate(call.content ?? ''),
          })),
          toolCounts,
          wallClockSeconds: questionSeconds,
          tokens: {
            deepseekAgent: copyTokenUsage(result.usage),
            concentrationIngestion: {
              ...copyProviderUsage(conversationIngestionUsage),
              attribution: 'conversation-shared',
            },
            geminiJudge: questionJudgeUsage,
          },
        });
        options.onProgress?.(buildResult());
      }
    } finally {
      await real.cleanup();
    }
  }

  return buildResult();
}
