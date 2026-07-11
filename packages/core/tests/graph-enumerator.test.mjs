import test from 'node:test';
import assert from 'node:assert/strict';

import { GraphEnumerator } from '../dist/store/graph-enumerator.js';

const mem = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function triple(id, subject, relation, object, memoryNum) {
  return {
    id,
    subject,
    relation,
    object,
    sourceMemoryId: mem(memoryNum),
    createdAt: memoryNum,
  };
}

class FakeGraphStore {
  constructor(triples, relatedByQuery = new Map()) {
    this.triples = triples;
    this.relatedByQuery = relatedByQuery;
    this.calls = [];
  }

  async findTriplesByEntity(entity, direction = 'both', limit = 1000) {
    this.calls.push(`exact:${entity}:${direction}`);
    const out = direction === 'out' || direction === 'both'
      ? this.triples.filter(t => t.subject === entity)
      : [];
    const incoming = direction === 'in' || direction === 'both'
      ? this.triples.filter(t => t.object === entity)
      : [];
    const byId = new Map();
    for (const candidate of [...out, ...incoming]) byId.set(candidate.id, candidate);
    return Array.from(byId.values()).slice(0, limit);
  }

  async findRelatedEntities(queryText) {
    this.calls.push(`ann:${queryText}`);
    return this.relatedByQuery.get(queryText) ?? [];
  }
}

const orthogonalEmbedder = {
  async embed(text) {
    return text === 'unmatched relation' ? [1, 0] : [0, 1];
  },
};

test('GraphEnumerator does exact-first lookup before ANN alias fanout', async () => {
  const exact = triple('t-exact', 'HiddenAnchor', 'owns', 'ExactSibling', 1);
  const alias = triple('t-alias', 'AliasAnchor', 'owns', 'AliasSibling', 2);
  const store = new FakeGraphStore([
    exact,
    alias,
  ], new Map([
    ['HiddenAnchor', [alias]],
  ]));
  const enumerator = new GraphEnumerator(store, orthogonalEmbedder);

  const result = await enumerator.enumerate({
    anchors: ['HiddenAnchor'],
    setMode: 'union',
    direction: 'out',
  });

  assert.deepEqual(store.calls.slice(0, 2), ['exact:HiddenAnchor:out', 'ann:HiddenAnchor']);
  assert.deepEqual(result.answers.map(answer => answer.entity), ['AliasSibling', 'ExactSibling']);
  assert.equal(result.answers.find(answer => answer.entity === 'ExactSibling').sourceMemoryIds[0], mem(1));
});

test('GraphEnumerator projects out, in, and both directions from the matched side', async () => {
  const store = new FakeGraphStore([
    triple('t-out', 'Alice', 'likes', 'Bob', 1),
    triple('t-in', 'Carol', 'likes', 'Alice', 2),
    triple('t-out-2', 'Alice', 'worksWith', 'Dana', 3),
  ]);
  const enumerator = new GraphEnumerator(store, orthogonalEmbedder);

  const out = await enumerator.enumerate({ anchors: ['Alice'], setMode: 'union', direction: 'out' });
  assert.deepEqual(out.answers.map(answer => answer.entity), ['Bob', 'Dana']);

  const incoming = await enumerator.enumerate({ anchors: ['Alice'], setMode: 'union', direction: 'in' });
  assert.deepEqual(incoming.answers.map(answer => answer.entity), ['Carol']);

  const both = await enumerator.enumerate({ anchors: ['Alice'], setMode: 'union', direction: 'both' });
  assert.deepEqual(both.answers.map(answer => answer.entity), ['Bob', 'Carol', 'Dana']);
  assert.deepEqual(
    both.answers.find(answer => answer.entity === 'Carol').evidenceTriples.map(triple => [triple.subject, triple.relation, triple.object]),
    [['Carol', 'likes', 'Alice']],
  );
});

test('GraphEnumerator supports union and all-anchor intersection modes', async () => {
  const store = new FakeGraphStore([
    triple('t-alice-bob', 'Alice', 'likes', 'Bob', 1),
    triple('t-alice-dana', 'Alice', 'likes', 'Dana', 2),
    triple('t-team-bob', 'Team', 'hasMember', 'Bob', 3),
    triple('t-team-erin', 'Team', 'hasMember', 'Erin', 4),
  ]);
  const enumerator = new GraphEnumerator(store, orthogonalEmbedder);

  const union = await enumerator.enumerate({ anchors: ['Alice', 'Team'], setMode: 'union', direction: 'out' });
  assert.deepEqual(union.answers.map(answer => answer.entity), ['Bob', 'Dana', 'Erin']);

  const intersection = await enumerator.enumerate({ anchors: ['Alice', 'Team'], setMode: 'intersection', direction: 'out' });
  assert.deepEqual(intersection.answers.map(answer => answer.entity), ['Bob']);

  const compare = await enumerator.enumerate({ anchors: ['Alice', 'Team'], setMode: 'compare', direction: 'out' });
  assert.deepEqual(compare.answers.map(answer => answer.entity), ['Bob']);
});

test('GraphEnumerator relation fallback groups by relation, caps per relation, and is deterministic', async () => {
  const store = new FakeGraphStore([
    triple('z-family', 'Fallback', 'family', 'Zed', 1),
    triple('a-pet', 'Fallback', 'pet', 'Alpha', 2),
    triple('a-family', 'Fallback', 'family', 'Alice', 3),
    triple('b-pet', 'Fallback', 'pet', 'Beta', 4),
  ]);
  const enumerator = new GraphEnumerator(store, orthogonalEmbedder, {
    relationThreshold: 0.99,
    fallbackPerRelationLimit: 1,
  });
  const plan = {
    anchors: ['Fallback'],
    setMode: 'union',
    direction: 'out',
    relationText: 'unmatched relation',
  };

  const first = await enumerator.enumerate(plan);
  const second = await enumerator.enumerate(plan);

  assert.equal(first.fallbackUsed, true);
  assert.deepEqual(first, second);
  assert.deepEqual(first.answers.map(answer => answer.entity), ['Alice', 'Alpha']);
  assert.deepEqual(first.answers.map(answer => answer.evidenceTriples[0].relation), ['family', 'pet']);
});
