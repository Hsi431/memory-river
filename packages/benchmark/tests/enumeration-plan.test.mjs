import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEnumerationPlan } from '../dist/harness/enumeration-plan.js';

function fakeConversation(overrides = {}) {
  return {
    sampleId: 'conv-test',
    speakerA: 'Alice',
    speakerB: 'Bob',
    sessions: [
      {
        index: 1,
        dateTime: '',
        turns: [
          { speaker: 'Alice', diaId: 'D1:1', text: 'I visited Paris with Charlie.' },
          { speaker: 'Bob', diaId: 'D1:2', text: 'Charlie recommended Cafe Luna.' },
        ],
        messages: [],
      },
    ],
    qa: [
      {
        question: 'should not be read',
        answer: new Proxy({}, {
          get() {
            throw new Error('planner read qa.answer');
          },
        }),
        evidence: new Proxy([], {
          get() {
            throw new Error('planner read qa.evidence');
          },
        }),
        category: 1,
      },
    ],
    ...overrides,
  };
}

test('both speaker question uses intersection with two anchors', () => {
  const result = buildEnumerationPlan('What common places do Alice and Bob both mention?', fakeConversation());

  assert.equal(result.plannerSkipped, false);
  assert.equal(result.fallbackUsed, false);
  assert.deepEqual(result.plan?.anchors, ['Alice', 'Bob']);
  assert.equal(result.plan?.setMode, 'intersection');
});

test('single speaker question uses union with one anchor', () => {
  const result = buildEnumerationPlan('What did Alice say about Paris?', fakeConversation());

  assert.equal(result.plannerSkipped, false);
  assert.equal(result.fallbackUsed, false);
  assert.deepEqual(result.plan?.anchors, ['Alice']);
  assert.equal(result.plan?.setMode, 'union');
});

test('speakerless question can anchor on a question entity', () => {
  const result = buildEnumerationPlan('What was said about Charlie?', fakeConversation());

  assert.equal(result.plannerSkipped, false);
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(result.plan?.anchors, ['Charlie']);
  assert.equal(result.plan?.setMode, 'union');
});

test('truly unanchorable question is skipped', () => {
  const result = buildEnumerationPlan('what about it?', fakeConversation({
    sessions: [{ index: 1, dateTime: '', turns: [], messages: [] }],
  }));

  assert.equal(result.plannerSkipped, true);
  assert.equal(result.plan, undefined);
});
