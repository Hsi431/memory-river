import assert from 'node:assert/strict';
import { buildDualTrackPrompt, buildSimplePrompt } from '../dist/distill/concentrator-adapter.js';

const conversation = [
  'USER: 幫我修 concentrator prompt 丟失正文的 bug',
  'ASSISTANT: 我先檢查 buildDualTrackPrompt 的組裝方式',
  'USER: 另外注意不要把 JSON 格式要求當成記憶內容',
].join('\n\n');

const dualPrompt = buildDualTrackPrompt(conversation);
const simplePrompt = buildSimplePrompt(conversation);

assert.ok(dualPrompt.includes('=== BEGIN REAL CONVERSATION ==='));
assert.ok(dualPrompt.includes('=== END REAL CONVERSATION ==='));
assert.ok(dualPrompt.includes(conversation));
assert.ok(dualPrompt.indexOf('=== BEGIN REAL CONVERSATION ===') < dualPrompt.indexOf(conversation));
assert.ok(simplePrompt.includes(conversation));

console.log('concentrator_prompt_test: OK');
