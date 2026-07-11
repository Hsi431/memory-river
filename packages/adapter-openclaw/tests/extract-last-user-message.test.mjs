import test from 'node:test';
import assert from 'node:assert/strict';

import { extractLastUserMessage } from '../dist/index.js';

function user(content) {
  return { role: 'user', content };
}

test('pure conversation_info metadata strips to empty and skips', () => {
  const text = [
    'Conversation info (untrusted metadata):',
    '```json',
    '{"message_id":"1"}',
    '```',
    '',
  ].join('\n');

  assert.equal(extractLastUserMessage([user(text)]), '');
});

test('conversation_info plus real question extracts question', () => {
  const text = [
    'Conversation info (untrusted metadata):',
    '```json',
    '{"message_id":"1"}',
    '```',
    '',
    '回想一下我去高雄幹麻',
  ].join('\n');

  assert.equal(extractLastUserMessage([user(text)]), '回想一下我去高雄幹麻');
});

test('conversation_info plus sender metadata extracts Discord question', () => {
  const text = [
    'Conversation info (untrusted metadata):',
    '```json',
    '{"message_id":"1"}',
    '```',
    '',
    'Sender (untrusted metadata):',
    '```json',
    '{"name":"芬達曾"}',
    '```',
    '',
    '回想一下我去高雄幹麻',
  ].join('\n');

  assert.equal(extractLastUserMessage([user(text)]), '回想一下我去高雄幹麻');
});

test('multiple metadata blocks with empty question skips', () => {
  const text = [
    'Conversation info (untrusted metadata):',
    '{"message_id":"1"}',
    '',
    'Sender (untrusted metadata):',
    '{"name":"芬達曾"}',
    '',
  ].join('\n');

  assert.equal(extractLastUserMessage([user(text)]), '');
});

test('plain question passes through', () => {
  assert.equal(extractLastUserMessage([user('回想一下我去高雄幹麻')]), '回想一下我去高雄幹麻');
});

test('metadata heading is case-insensitive and accepts fullwidth colon, CRLF, trailing space', () => {
  const text = [
    'conversation INFO (untrusted metadata)：   ',
    '{"message_id":"1"}',
    '',
    'sender (UNTRUSTED METADATA)：   ',
    '{"name":"芬達曾"}',
    '',
    '回想一下我去高雄幹麻   ',
  ].join('\r\n');

  assert.equal(extractLastUserMessage([user(text)]), '回想一下我去高雄幹麻');
});
