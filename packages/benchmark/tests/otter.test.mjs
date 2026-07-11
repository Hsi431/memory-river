import assert from 'node:assert/strict';
import test from 'node:test';

import { OTTER_TOOLS, turnText } from '../dist/agent/otter.js';
import { runToolLoop } from '../dist/harness/tool-llm.js';

function completion(message, finishReason = 'stop', usage = { promptTokens: 0, completionTokens: 0 }) {
  return {
    message: { role: 'assistant', ...message },
    finishReason,
    usage,
  };
}

test('turnText includes the UTC date from rehydrated transcript timestamps', () => {
  const timestamp = Date.parse('2023-05-07T00:00:00Z');
  assert.equal(
    turnText([{
      entryId: 1,
      user: 'Caroline: I joined the support group yesterday.',
      assistant: 'Melanie: That sounds helpful.',
      timestamp,
    }]),
    '[T1]\n' +
      '[2023-05-07] user: Caroline: I joined the support group yesterday.\n' +
      '[2023-05-07] assistant: Melanie: That sounds helpful.',
  );
});

test('Otter exposes the full memory-river tool surface as valid schemas', () => {
  for (const tool of OTTER_TOOLS) {
    assert.equal(tool.type, 'function');
    assert.equal(typeof tool.function.name, 'string');
    assert.equal(typeof tool.function.description, 'string');
    assert.equal(tool.function.parameters.type, 'object');
    assert.equal(typeof tool.function.parameters.properties, 'object');
    assert.doesNotThrow(() => JSON.stringify(tool));
  }
  // Mirrors the 9 tools the real adapter registers (adapter-openclaw/src/index.ts):
  // recall/rehydrate/store + gwm on/off/status/update + skill save/load.
  assert.deepEqual(
    OTTER_TOOLS.map(tool => tool.function.name),
    [
      'memory_recall',
      'memory_rehydrate',
      'memory_store',
      'gwm_on',
      'gwm_off',
      'gwm_status',
      'gwm_update',
      'skill_save',
      'skill_load',
    ],
  );
});

test('runToolLoop dispatches scripted tool calls and returns the final answer', async () => {
  const requests = [];
  const executed = [];
  const toolResults = [];
  const replies = [
    completion({
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'memory_recall', arguments: '{"query":"blue","limit":3}' },
      }],
    }, 'tool_calls', { promptTokens: 100, completionTokens: 20 }),
    completion(
      { content: 'Alex likes blue.' },
      'stop',
      { promptTokens: 150, completionTokens: 10 },
    ),
  ];

  const result = await runToolLoop({
    apiKey: 'test',
    model: 'mock',
    system: 'system',
    userMessages: [{ role: 'user', content: 'question' }],
    tools: OTTER_TOOLS,
    async execute(name, args) {
      executed.push({ name, args });
      return { content: '• Alex likes blue.', resultCount: 1 };
    },
    onToolResult(event) {
      toolResults.push(event);
    },
    async complete(request) {
      requests.push(request);
      return replies.shift();
    },
  });

  assert.equal(result.answer, 'Alex likes blue.');
  assert.equal(result.capExhausted, false);
  assert.deepEqual(executed, [
    { name: 'memory_recall', args: { query: 'blue', limit: 3 } },
  ]);
  assert.deepEqual(result.trace, [
    {
      name: 'memory_recall',
      args: { query: 'blue', limit: 3 },
    },
  ]);
  assert.deepEqual(toolResults, [{
    name: 'memory_recall',
    args: { query: 'blue', limit: 3 },
    content: '• Alex likes blue.',
    resultCount: 1,
  }]);
  assert.equal(requests.length, 2);
  assert.deepEqual(result.usage, {
    calls: 2,
    promptTokens: 250,
    completionTokens: 30,
  });
  // tool-llm no longer pins a budget; it inherits the client's generous default
  // (deepseek-llm MAX_TOKENS, env-tunable) so reasoning models aren't truncated.
  assert.ok(requests.every(request => request.maxTokens === undefined));
  assert.equal(requests[1].messages.at(-1).role, 'tool');
});

test('runToolLoop parses DeepSeek DSML content into typed tool calls', async () => {
  const requests = [];
  const executed = [];
  const replies = [
    completion({
      content: [
        '<｜｜DSML｜｜tool_calls>',
        '<｜｜DSML｜｜invoke name="memory_recall">',
        '<｜｜DSML｜｜parameter name="query" string="true">小薇 &amp; 海狸</｜｜DSML｜｜parameter>',
        '<｜｜DSML｜｜parameter name="limit" string="false">10</｜｜DSML｜｜parameter>',
        '</｜｜DSML｜｜invoke>',
        '<｜｜DSML｜｜invoke name="gwm_off"></｜｜DSML｜｜invoke>',
        '</｜｜DSML｜｜tool_calls>',
      ].join('\n'),
    }),
    completion({ content: 'Recovered answer.' }),
  ];

  const result = await runToolLoop({
    apiKey: 'test',
    model: 'mock',
    system: 'system',
    userMessages: [{ role: 'user', content: 'question' }],
    tools: OTTER_TOOLS,
    async execute(name, args) {
      executed.push({ name, args });
      return 'ok';
    },
    async complete(request) {
      requests.push(request);
      return replies.shift();
    },
  });

  assert.equal(result.answer, 'Recovered answer.');
  assert.deepEqual(executed, [
    { name: 'memory_recall', args: { query: '小薇 & 海狸', limit: 10 } },
    { name: 'gwm_off', args: {} },
  ]);
  assert.equal(requests[1].messages.at(-1).role, 'tool');
  const assistant = requests[1].messages.find(message => message.role === 'assistant');
  assert.equal(assistant.content, null);
  assert.equal(assistant.tool_calls.length, 2);
});

test('runToolLoop retries malformed DSML instead of returning it as an answer', async () => {
  const leaked = [
    '<｜｜DSML｜｜tool_calls>',
    '<｜｜DSML｜｜invoke name="memory_recall">',
    '<｜｜DSML｜｜parameter name="limit" string="false">not-json</｜｜DSML｜｜parameter>',
    '</｜｜DSML｜｜invoke>',
    '</｜｜DSML｜｜tool_calls>',
  ].join('\n');
  const requests = [];
  const replies = [
    completion({ content: leaked }),
    completion({ content: 'Clean retry answer.' }),
  ];

  const result = await runToolLoop({
    apiKey: 'test',
    model: 'mock',
    system: 'system',
    userMessages: [{ role: 'user', content: 'question' }],
    tools: OTTER_TOOLS,
    async execute() {
      assert.fail('malformed DSML must not execute');
    },
    async complete(request) {
      requests.push(request);
      return replies.shift();
    },
  });

  assert.equal(result.answer, 'Clean retry answer.');
  assert.equal(result.trace.length, 0);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /malformed native tool-call markup/);
});

test('runToolLoop forces a no-tools final call when the call cap is exhausted', async () => {
  const requests = [];
  const replies = [
    completion({
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'memory_recall', arguments: '{"query":"one"}' },
      }],
    }, 'tool_calls'),
    completion({ content: 'Forced final answer.' }),
  ];

  const result = await runToolLoop({
    apiKey: 'test',
    model: 'mock',
    system: 'system',
    userMessages: [{ role: 'user', content: 'question' }],
    tools: OTTER_TOOLS,
    maxCalls: 1,
    async execute() {
      return '';
    },
    async complete(request) {
      requests.push(request);
      return replies.shift();
    },
  });

  assert.equal(result.answer, 'Forced final answer.');
  assert.equal(result.capExhausted, true);
  assert.equal(result.trace.length, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools, OTTER_TOOLS);
  assert.equal(requests[1].tools, undefined);
  const finalMessages = requests[1].messages;
  assert.equal(finalMessages[finalMessages.length - 1].role, 'user');
  assert.match(finalMessages[finalMessages.length - 1].content, /無法再使用任何工具/);
});
