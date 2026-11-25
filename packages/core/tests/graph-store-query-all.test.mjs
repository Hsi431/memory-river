import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as lancedb from '@lancedb/lancedb';
import { GraphStore } from '../dist/store/graph-store.js';

test('findTriplesByMemoryId returns every triple beyond its former hundred-row cap', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-graph-memory-many-'));
  const ramDb = await lancedb.connect(path.join(root, 'ram'));
  const ssdDb = await lancedb.connect(path.join(root, 'ssd'));
  const memoryId = 'memory-with-many-triples';
  try {
    await ramDb.createTable('graph_triples', Array.from({ length: 101 }, (_, index) => ({
      id: `triple-${String(index).padStart(3, '0')}`,
      subject: `subject-${index}`,
      relation: 'relates_to',
      object: `object-${index}`,
      sourceMemoryId: memoryId,
      vector: [0.1, 0.2, 0.3, 0.4],
      createdAt: index,
    })));
    const graph = new GraphStore(ramDb, ssdDb, { embed: async () => [0.1, 0.2, 0.3, 0.4] }, 4);

    const triples = await graph.findTriplesByMemoryId(memoryId);

    assert.equal(triples.length, 101);
    assert.equal(new Set(triples.map(triple => triple.id)).size, 101);
  } finally {
    await ramDb.close();
    await ssdDb.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
