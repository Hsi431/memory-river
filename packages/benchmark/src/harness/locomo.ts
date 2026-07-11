import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ContextMessage } from '@memory-river/core';

export interface LocomoTurn {
  speaker: string;
  diaId: string;
  text: string;
}

export interface LocomoSession {
  index: number;
  dateTime: string;
  turns: LocomoTurn[];
  messages: ContextMessage[];
}

export interface LocomoQa {
  question: string;
  answer?: string | number;
  evidence: string[];
  category: number;
  sourceIndex?: number;
}

export interface LocomoConversation {
  sampleId: string;
  speakerA: string;
  speakerB: string;
  sessions: LocomoSession[];
  qa: LocomoQa[];
}

interface RawTurn {
  speaker: string;
  dia_id: string;
  text: string;
}

interface RawQa {
  question: string;
  answer?: string | number;
  evidence?: string[];
  category: number;
}

interface RawSample {
  sample_id: string;
  conversation: Record<string, string | RawTurn[]>;
  qa: RawQa[];
}

function parseSessionTimestamp(dateTime: string, fallback: number): number {
  const locomoDate = dateTime.match(
    /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),\s*(\d{4})$/i,
  );
  const normalized = locomoDate
    ? `${locomoDate[4]} ${locomoDate[5]} ${locomoDate[6]} ${locomoDate[1]}:${locomoDate[2]} ${locomoDate[3]} UTC`
    : `${dateTime} UTC`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

export function locomoDatasetPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '..', 'datasets', 'external', 'locomo10.json');
}

export function parseLocomo(input: unknown): LocomoConversation[] {
  if (!Array.isArray(input)) throw new Error('LoCoMo dataset must be an array');

  // The sourceEntryIds probe and archiveSnapshot both key off msg.timestamp.
  // Use each LoCoMo session's source date with deterministic per-turn offsets,
  // falling back to a stable synthetic timeline when the date cannot be parsed.
  // The same message objects are reused for archiving and compaction.
  const TS_BASE = 1_700_000_000_000;
  const TS_STEP = 60_000;

  return (input as RawSample[]).map(sample => {
    const speakerA = String(sample.conversation.speaker_a ?? '');
    const speakerB = String(sample.conversation.speaker_b ?? '');
    const sessionKeys = Object.keys(sample.conversation)
      .filter(key => /^session_\d+$/.test(key) && Array.isArray(sample.conversation[key]))
      .sort((left, right) => Number(left.slice(8)) - Number(right.slice(8)));

    let globalTurn = 0;
    const sessions = sessionKeys.map(key => {
      const index = Number(key.slice(8));
      const dateTime = String(sample.conversation[`${key}_date_time`] ?? '');
      const sessionTimestamp = parseSessionTimestamp(
        dateTime,
        TS_BASE + globalTurn * TS_STEP,
      );
      const rawTurns = sample.conversation[key] as RawTurn[];
      const turns = rawTurns.map(turn => ({
        speaker: String(turn.speaker),
        diaId: String(turn.dia_id),
        text: String(turn.text),
      }));
      const messages = turns.map((turn, turnIndex) => {
        if (turn.speaker !== speakerA && turn.speaker !== speakerB) {
          throw new Error(`Unknown LoCoMo speaker: ${turn.speaker}`);
        }
        const fallbackTimestamp = TS_BASE + globalTurn * TS_STEP;
        globalTurn++;
        return {
          role: turn.speaker === speakerA ? 'user' as const : 'assistant' as const,
          content: `${turn.speaker}: ${turn.text}`,
          timestamp: dateTime
            ? sessionTimestamp + turnIndex * TS_STEP
            : fallbackTimestamp,
          metadata: {
            locomo: {
              sessionDateTime: dateTime,
              speaker: turn.speaker,
              diaId: turn.diaId,
            },
          },
        };
      });
      return { index, dateTime, turns, messages };
    });

    return {
      sampleId: String(sample.sample_id),
      speakerA,
      speakerB,
      sessions,
      qa: sample.qa.map(item => ({
        question: String(item.question),
        answer: item.answer,
        evidence: Array.isArray(item.evidence) ? item.evidence.map(String) : [],
        category: Number(item.category),
      })),
    };
  });
}

export function loadLocomo(filePath = locomoDatasetPath()): LocomoConversation[] {
  return parseLocomo(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}
