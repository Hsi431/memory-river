/**
 * CI-safe fixture-integrity test for zh-mixed.json and the zh-chat parser.
 * No Ollama, no API keys required.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseZhMixed, loadZhMixed } from '../dist/dimensions/zh-chat.js';

// ─── Inline raw fixture (same shape as the file) for isolated parse tests ─────

const RAW_FIXTURE = {
  version: 'zh-mixed-v1',
  description: 'test',
  speakerA: '阿哲',
  speakerB: '小幫手',
  sessions: [
    {
      index: 1,
      dateTime: '2026-03-02T12:00:00+08:00',
      turns: [
        { speaker: '阿哲', diaId: 's1-1', text: '我這週開始接一個新專案。' },
        { speaker: '小幫手', diaId: 's1-2', text: '聽起來很關鍵。' },
      ],
    },
    {
      index: 2,
      dateTime: '2026-03-09T12:00:00+08:00',
      turns: [
        { speaker: '阿哲', diaId: 's2-1', text: '我昨天把家搬完了。' },
        { speaker: '小幫手', diaId: 's2-2', text: '太好了。' },
      ],
    },
  ],
  qa: [
    {
      question: '阿哲在做什麼專案?',
      answer: '新專案',
      evidence: ['s1-1'],
      category: 'factual',
    },
    {
      question: '阿哲什麼時候搬家?',
      answer: '2026年3月8日',
      evidence: ['s2-1'],
      category: 'temporal',
    },
  ],
};

test('parseZhMixed maps speakerA turns to role:user and speakerB to role:assistant', () => {
  const fixture = parseZhMixed(RAW_FIXTURE);
  const [s1] = fixture.sessions;
  assert.equal(s1.messages[0].role, 'user');
  assert.equal(s1.messages[1].role, 'assistant');
});

test('parseZhMixed builds plain "speaker: text" content without [date] prefix', () => {
  const fixture = parseZhMixed(RAW_FIXTURE);
  const [s1] = fixture.sessions;
  assert.equal(s1.messages[0].content, '阿哲: 我這週開始接一個新專案。');
  assert.equal(s1.messages[1].content, '小幫手: 聽起來很關鍵。');
  // Ensure no bracket-prefixed date token is present
  for (const session of fixture.sessions) {
    for (const msg of session.messages) {
      assert.ok(
        !msg.content.startsWith('['),
        `Content must not start with "[": ${msg.content}`,
      );
    }
  }
});

test('parseZhMixed parses ISO +08:00 timestamps preserving Taiwan calendar date', () => {
  const fixture = parseZhMixed(RAW_FIXTURE);
  const [s1, s2] = fixture.sessions;

  // 2026-03-02T12:00:00+08:00 → UTC epoch for that moment
  const expected1 = Date.parse('2026-03-02T12:00:00+08:00');
  assert.equal(s1.messages[0].timestamp, expected1);
  // Second turn is +60s
  assert.equal(s1.messages[1].timestamp, expected1 + 60_000);

  // Second session
  const expected2 = Date.parse('2026-03-09T12:00:00+08:00');
  assert.equal(s2.messages[0].timestamp, expected2);

  // UTC wall-clock date for 2026-03-02T12:00:00+08:00 = 2026-03-02T04:00:00Z
  // → calendar date is still March 2, not March 1.
  const utcDay = new Date(expected1).getUTCDate();
  assert.equal(utcDay, 2, 'Taiwan calendar date must not shift under UTC');
});

test('parseZhMixed QA categories are in the allowed set', () => {
  const fixture = parseZhMixed(RAW_FIXTURE);
  const allowed = new Set(['factual', 'temporal', 'multi_hop']);
  for (const qa of fixture.qa) {
    assert.ok(allowed.has(qa.category), `Unknown category: ${qa.category}`);
  }
});

test('parseZhMixed collects all diaIds from turns', () => {
  const fixture = parseZhMixed(RAW_FIXTURE);
  assert.ok(fixture.allDiaIds.has('s1-1'));
  assert.ok(fixture.allDiaIds.has('s1-2'));
  assert.ok(fixture.allDiaIds.has('s2-1'));
  assert.ok(fixture.allDiaIds.has('s2-2'));
});

test('parseZhMixed rejects unknown category', () => {
  const bad = {
    ...RAW_FIXTURE,
    qa: [{ question: 'q', answer: 'a', evidence: [], category: 'unknown' }],
  };
  assert.throws(() => parseZhMixed(bad), /unknown category/i);
});

test('parseZhMixed rejects unknown speaker', () => {
  const bad = {
    ...RAW_FIXTURE,
    sessions: [{
      index: 1,
      dateTime: '2026-03-02T12:00:00+08:00',
      turns: [{ speaker: '陌生人', diaId: 'x1', text: '你好' }],
    }],
  };
  assert.throws(() => parseZhMixed(bad), /unknown speaker/i);
});

test('zh-mixed.json file: all qa evidence diaIds exist in session turns', () => {
  const fixture = loadZhMixed();
  for (const qa of fixture.qa) {
    for (const diaId of qa.evidence) {
      assert.ok(
        fixture.allDiaIds.has(diaId),
        `qa evidence diaId "${diaId}" not found in any session turn`,
      );
    }
  }
});

test('zh-mixed.json file: all qa categories are in the allowed set', () => {
  const fixture = loadZhMixed();
  const allowed = new Set(['factual', 'temporal', 'multi_hop']);
  for (const [i, qa] of fixture.qa.entries()) {
    assert.ok(allowed.has(qa.category), `qa[${i}].category "${qa.category}" not allowed`);
  }
});

test('zh-mixed.json file: speakerA and speakerB cover all turn speakers', () => {
  const fixture = loadZhMixed();
  const validSpeakers = new Set([fixture.speakerA, fixture.speakerB]);
  for (const session of fixture.sessions) {
    for (const turn of session.turns) {
      assert.ok(
        validSpeakers.has(turn.speaker),
        `Turn speaker "${turn.speaker}" is neither speakerA nor speakerB`,
      );
    }
  }
});

test('zh-mixed.json file: sessions are ordered and have at least one turn each', () => {
  const fixture = loadZhMixed();
  assert.ok(fixture.sessions.length > 0, 'Must have at least one session');
  for (let i = 1; i < fixture.sessions.length; i++) {
    assert.ok(
      fixture.sessions[i].index > fixture.sessions[i - 1].index,
      'Sessions must be in ascending index order',
    );
  }
  for (const session of fixture.sessions) {
    assert.ok(session.turns.length > 0, `Session ${session.index} has no turns`);
  }
});
