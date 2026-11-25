import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renderLocomoRelationProbe,
  usage as enumNoiseUsage,
} from '../dist/harness/locomo-enum-noise-audit.js';
import {
  renderLocomoSiblingRecall,
  usage as siblingRecallUsage,
} from '../dist/harness/locomo-sibling-recall.js';

const oracleLabel = 'ORACLE_DIAGNOSTIC — 不是產品分數';

test('relation-table output is labeled as an oracle diagnostic', () => {
  const report = renderLocomoRelationProbe({
    diagnostic: oracleLabel,
    metricLabel: 'LoCoMo Relation Discrimination Probe',
    conversations: 0,
    category: 1,
    questions: 0,
    scoredQuestions: 0,
    ablations: [],
    parityCheck: null,
    warnings: [],
  });

  assert.ok(report.includes(oracleLabel));
});

test('sibling-recall output is labeled as an oracle diagnostic', () => {
  const report = renderLocomoSiblingRecall({
    diagnostic: oracleLabel,
    metricLabel: 'SiblingRecall@10(memory_layer_direct)',
    description: 'Oracle/deterministic enumeration plan.',
    metrics: {
      conversations: 0,
      category: 1,
      k: 10,
      questions: 0,
      scoredQuestions: 0,
      plannerSkipped: 0,
      plannerSkippedRate: 0,
      fallbackUsed: 0,
      fallbackUsedRate: 0,
      meanSiblingRecallAtK: 0,
      graphPresenceRate: 0,
      notePresenceRate: 0,
      noiseAt10: 0,
      presence: { goldEntryIds: 0, notePresent: 0, graphPresent: 0 },
    },
    questions: [],
    warnings: [],
  });

  assert.ok(report.includes(oracleLabel));
});

test('oracle diagnostic help warns that the tools do not report product scores', () => {
  const output = [];
  const originalError = console.error;
  console.error = (...values) => output.push(values.join(' '));
  try {
    enumNoiseUsage();
    siblingRecallUsage();
  } finally {
    console.error = originalError;
  }

  assert.equal(output.length, 2);
  assert.ok(output.every(line => line.includes(oracleLabel)));
});
