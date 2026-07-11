import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { analyzePluginInit } from '../../../scripts/inspect-effectiveness.mjs';

const buildDir = process.env.MEMORY_RIVER_BUILD_DIR
  ? path.resolve(process.env.MEMORY_RIVER_BUILD_DIR)
  : path.resolve('dist');

let importCounter = 0;

async function importIndex() {
  return await import(`${pathToFileURL(path.join(buildDir, 'index.js')).href}?plugin_init_smoke=${importCounter++}`);
}

test('recordPluginInitSmokeStat writes succeeded init_completed event', async () => {
  const { recordPluginInitSmokeStat } = await importIndex();
  const events = [];
  const store = {
    recordSubsystemEffectiveness: async event => events.push(event),
  };

  await recordPluginInitSmokeStat(store, 'succeeded');

  assert.equal(events.length, 1);
  assert.equal(events[0].subsystem, 'plugin');
  assert.equal(events[0].event, 'init_completed');
  assert.equal(events[0].outcome, 'succeeded');
  assert.deepEqual(events[0].metadata, {});
});

test('recordPluginInitSmokeStat writes failed init metadata', async () => {
  const { recordPluginInitSmokeStat } = await importIndex();
  const events = [];
  const store = {
    recordSubsystemEffectiveness: async event => events.push(event),
  };

  await recordPluginInitSmokeStat(store, 'failed', new Error('db unavailable'));

  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'failed');
  assert.deepEqual(events[0].metadata, { error: 'db unavailable' });
});

test('recordPluginInitSmokeStat never throws when stat write fails', async () => {
  const { recordPluginInitSmokeStat } = await importIndex();
  const store = {
    recordSubsystemEffectiveness: async () => {
      throw new Error('stat down');
    },
  };

  await assert.doesNotReject(recordPluginInitSmokeStat(store, 'failed', new Error('init down')));
});

test('analyzePluginInit reports no_init_record when no events exist', () => {
  const report = analyzePluginInit([], Date.parse('2026-05-06T12:00:00.000Z'));

  assert.equal(report.eventCount, 0);
  assert.equal(report.last, null);
  assert.match(report.verdict, /no_init_record/);
});

test('analyzePluginInit reports init_failed for latest failed event', () => {
  const report = analyzePluginInit([
    { ts: '2026-05-06T10:00:00.000Z', subsystem: 'plugin', event: 'init_completed', outcome: 'succeeded', metadata: '' },
    { ts: '2026-05-06T11:00:00.000Z', subsystem: 'plugin', event: 'init_completed', outcome: 'failed', metadata: '{"error":"boom"}' },
  ], Date.parse('2026-05-06T12:00:00.000Z'));

  assert.equal(report.eventCount, 2);
  assert.equal(report.last.outcome, 'failed');
  assert.equal(report.verdict, '❌ init_failed');
});

test('analyzePluginInit reports healthy for latest succeeded event under 24h', () => {
  const report = analyzePluginInit([
    { ts: '2026-05-06T11:00:00.000Z', subsystem: 'plugin', event: 'init_completed', outcome: 'succeeded', metadata: '' },
  ], Date.parse('2026-05-06T12:00:00.000Z'));

  assert.equal(report.eventCount, 1);
  assert.equal(report.last.outcome, 'succeeded');
  assert.equal(report.verdict, '✅ healthy');
});
