import assert from 'node:assert/strict';
import {
  extractTextForConcentrationContent,
  isFrameworkMetadataForConcentration,
  stripFrameworkMetadataForConcentration,
} from '../dist/distill/concentrator-adapter.js';

const startupText = 'A new session was started via /new or /reset. Run your Session Startup sequence - read the required files before responding.';
assert.equal(isFrameworkMetadataForConcentration(startupText), true);
assert.equal(isFrameworkMetadataForConcentration('真正的使用者需求：修 memory-river 的濃縮 bug'), false);
assert.equal(
  isFrameworkMetadataForConcentration('[Inter-session message] sourceSession=agent:xiaxia:subagent:abc sourceChannel=webchat sourceTool=subagent_announce [Sun 2026-04-26 00:10 GMT+8] OpenClaw runtime context'),
  true
);

const normalized = extractTextForConcentrationContent([
  { type: 'text', text: '第一段使用者內容' },
  { type: 'tool_use', text: '不該進 prompt' },
  { type: 'text', text: '第二段補充內容' },
]);

assert.equal(normalized, '第一段使用者內容\n第二段補充內容');

assert.equal(
  stripFrameworkMetadataForConcentration('[Inter-session message] sourceSession=agent:xiaxia:subagent:15c260b5-16de-42e2-b710-4380bf3dbfed sourceChannel=webchat sourceTool=subagent_announce [Sun 2026-04-26 00:10 GMT+8] OpenClaw runtime context...'),
  '[Sun 2026-04-26 00:10 GMT+8] OpenClaw runtime context...'
);

assert.equal(
  stripFrameworkMetadataForConcentration('[Inter-session message] sourceSession=agent[x]:subagent:abc sourceChannel=webchat sourceTool=subagent_announce [Tue 2026-04-28 14:37 GMT+8] 真正內容'),
  '[Tue 2026-04-28 14:37 GMT+8] 真正內容'
);

assert.equal(
  stripFrameworkMetadataForConcentration('[Inter-session message] sourceSession=agent:xiaxia sourceChannel=webchat sourceTool=subagent_announce no bracket payload'),
  ''
);

assert.equal(
  stripFrameworkMetadataForConcentration('正常內容不應該被改動'),
  '正常內容不應該被改動'
);

console.log('concentrator_filter_test: OK');
