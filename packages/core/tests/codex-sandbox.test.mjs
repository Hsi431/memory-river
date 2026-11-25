import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_CONFIG } from '../dist/types.js';
import { ConcentratorAdapter, runCodexCli } from '../dist/distill/concentrator-adapter.js';

test('codex calls use an empty data-local cwd, read-only sandbox, and skip-git flag', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mr-codex-sandbox-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const inboxPath = path.join(root, 'inbox');
  const adapter = new ConcentratorAdapter({
    apiKey: '',
    model: 'unused-model',
    provider: 'codex',
    codexWorkdir: DEFAULT_CONFIG.concentration.codexWorkdir,
    inboxPath,
    transcriptArchive: {},
    sessionSummaryDir: path.join(root, 'session-summaries'),
  });
  const codexOptions = adapter.buildCodexOptions('concentrate');
  const expectedWorkdir = path.join(path.dirname(inboxPath), 'codex-workdir');
  assert.equal(codexOptions.workdir, expectedWorkdir);

  let observed;
  const fakeExecFile = (file, args, options, callback) => {
    observed = { file, args, options };
    callback(null, '{"ok":true}', '');
    return { kill() { return true; }, stdin: { end() {} } };
  };
  assert.equal(await runCodexCli('summarize safely', codexOptions, fakeExecFile), '{"ok":true}');

  assert.equal(observed.file, 'codex');
  assert.equal(observed.options.cwd, expectedWorkdir);
  assert.ok(observed.args.includes('--sandbox'));
  assert.ok(observed.args.includes('read-only'));
  assert.ok(observed.args.includes('--skip-git-repo-check'));
  assert.ok(await stat(expectedWorkdir));
});
