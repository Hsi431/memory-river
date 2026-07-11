/**
 * zh-chat benchmark dimension.
 *
 * Loads the Chinese-first end-to-end fixture (zh-mixed.json) and drives the
 * full ingestion → Otter QA → Gemini/DeepSeek judge → metrics pipeline via
 * the shared conversation-benchmark runner.
 *
 * Timestamp handling:
 *   Each session has an ISO 8601 dateTime with +08:00 (Taiwan time).  We parse
 *   it directly with Date.parse(), which honours the offset and returns UTC ms —
 *   so a session at "2026-03-02T12:00:00+08:00" becomes
 *   Date.parse("2026-03-02T12:00:00+08:00") = 2026-03-02T04:00:00Z, keeping
 *   the Taiwan calendar date intact regardless of the server's local timezone.
 *   Each turn within a session adds a 60-second step so ordering is preserved
 *   and the concentrator can distinguish turns.
 *
 * Message content:
 *   Plain "speaker: text" — no "[date]" prefix, because the concentrator strips
 *   lines that start with a bracket-prefixed pattern.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ContextMessage } from '@memory-river/core';

import type { BenchmarkResult } from '../report.js';
import type { BenchmarkOptions } from './index.js';
import {
  runConversationBenchmark,
  type ConvSet,
  type ConvSession,
  type ConvTurn,
  type ConvQa,
} from './conversation-runner.js';

// ─── Fixture schema ───────────────────────────────────────────────────────────

const ALLOWED_CATEGORIES = new Set(['factual', 'temporal', 'multi_hop']);
const TS_STEP_MS = 60_000; // 1 minute between turns

interface RawTurn {
  speaker: string;
  diaId: string;
  text: string;
}

interface RawQa {
  question: string;
  answer: string;
  evidence: string[];
  category: string;
}

interface RawFixture {
  version: string;
  speakerA: string;
  speakerB: string;
  sessions: Array<{
    index: number;
    dateTime: string;
    turns: RawTurn[];
  }>;
  qa: RawQa[];
}

// ─── Parser ───────────────────────────────────────────────────────────────────

export interface ZhMixedFixture {
  speakerA: string;
  speakerB: string;
  sessions: ConvSession[];
  qa: ConvQa[];
  /** All diaIds that appear in turns — used by the integrity test */
  allDiaIds: Set<string>;
}

export function parseZhMixed(raw: unknown): ZhMixedFixture {
  const fixture = raw as RawFixture;
  if (!fixture.speakerA || !fixture.speakerB) {
    throw new Error('zh-mixed fixture must have speakerA and speakerB');
  }
  const { speakerA, speakerB } = fixture;
  const allDiaIds = new Set<string>();

  const sessions: ConvSession[] = fixture.sessions.map(rawSession => {
    // Parse ISO timestamp with +08:00 offset intact.
    const sessionTimestamp = Date.parse(rawSession.dateTime);
    if (!Number.isFinite(sessionTimestamp)) {
      throw new Error(`Cannot parse session dateTime: ${rawSession.dateTime}`);
    }

    const turns: ConvTurn[] = rawSession.turns.map(turn => {
      if (turn.speaker !== speakerA && turn.speaker !== speakerB) {
        throw new Error(`Unknown speaker "${turn.speaker}" in session ${rawSession.index}`);
      }
      allDiaIds.add(turn.diaId);
      return { speaker: turn.speaker, diaId: turn.diaId, text: turn.text };
    });

    const messages: ContextMessage[] = turns.map((turn, turnIndex) => ({
      role: turn.speaker === speakerA ? 'user' as const : 'assistant' as const,
      // Plain "speaker: text" — NO "[date]" prefix (concentrator strips those).
      content: `${turn.speaker}: ${turn.text}`,
      timestamp: sessionTimestamp + turnIndex * TS_STEP_MS,
      metadata: {
        zhChat: {
          sessionDateTime: rawSession.dateTime,
          speaker: turn.speaker,
          diaId: turn.diaId,
        },
      },
    }));

    return {
      index: rawSession.index,
      dateTime: rawSession.dateTime,
      turns,
      messages,
    };
  });

  const qa: ConvQa[] = fixture.qa.map((item, i) => {
    if (!ALLOWED_CATEGORIES.has(item.category)) {
      throw new Error(
        `qa[${i}] has unknown category "${item.category}" — allowed: ${[...ALLOWED_CATEGORIES].join(', ')}`,
      );
    }
    return {
      question: item.question,
      answer: item.answer,
      evidence: item.evidence,
      category: item.category,
    };
  });

  return { speakerA, speakerB, sessions, qa, allDiaIds };
}

export function zhMixedFixturePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '..', 'datasets', 'fixtures', 'zh-mixed.json');
}

export function loadZhMixed(filePath = zhMixedFixturePath()): ZhMixedFixture {
  return parseZhMixed(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

// ─── Dimension entry point ────────────────────────────────────────────────────

export async function runZhChatBenchmark(
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const fixture = loadZhMixed();

  // The fixture is a single "conversation" of 5 sessions.
  const conversation: ConvSet = {
    sampleId: 'zh-mixed-v1',
    sessions: fixture.sessions,
    qa: fixture.qa,
  };

  return runConversationBenchmark(
    [conversation],
    { dimensionName: 'zh-chat' },
    options,
  );
}
