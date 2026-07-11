import assert from 'node:assert/strict';
import test from 'node:test';

import { OllamaEmbeddingFunction } from '../dist/providers/ollama-embedding.js';

test('embeddingDataType works when called from ESM', () => {
  const dataType = new OllamaEmbeddingFunction().embeddingDataType();
  assert.equal(dataType.constructor.name, 'Float32');
});
