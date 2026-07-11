import type { EmbeddingProvider } from '@memory-river/core';

const DIMENSIONS = 256;

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  getDimensions(): number {
    return DIMENSIONS;
  }

  async embed(text: string): Promise<number[]> {
    const vector = Array<number>(DIMENSIONS).fill(0);
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
    for (const token of tokens) {
      const hash = hashToken(token);
      const index = hash % DIMENSIONS;
      vector[index] += (hash & 1) === 0 ? 1 : -1;
    }

    const norm = Math.hypot(...vector);
    if (norm === 0) {
      vector[0] = 1;
      return vector;
    }
    return vector.map(value => value / norm);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(text => this.embed(text)));
  }
}
