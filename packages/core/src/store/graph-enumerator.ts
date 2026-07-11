import type {
  EnumerationAnswer,
  EnumerationPlan,
  EnumerationResult,
} from '../types.js';
import type { EmbeddingProvider } from '../ports.js';
import type { GraphStore, GraphTriple } from './graph-store.js';

type Direction = 'out' | 'in' | 'both';

type GraphEnumeratorOptions = {
  relationThreshold?: number;
  fallbackPerRelationLimit?: number;
};

type ProjectedTriple = {
  entity: string;
  normalizedEntity: string;
  triple: GraphTriple;
};

type SeededTriple = {
  seed: string;
  triple: GraphTriple;
};

function normalizeEntity(entity: string): string {
  return entity.trim().toLocaleLowerCase();
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function stableTripleCompare(a: GraphTriple, b: GraphTriple): number {
  return a.relation.localeCompare(b.relation)
    || a.object.localeCompare(b.object)
    || a.subject.localeCompare(b.subject)
    || a.id.localeCompare(b.id);
}

export class GraphEnumerator {
  readonly relationThreshold: number;
  readonly fallbackPerRelationLimit: number;

  constructor(
    private readonly graphStore: Pick<GraphStore, 'findTriplesByEntity' | 'findRelatedEntities'>,
    private readonly embedder: Pick<EmbeddingProvider, 'embed'>,
    options: GraphEnumeratorOptions = {},
  ) {
    const envThreshold = Number(process.env.MR_ENUM_RELATION_THRESHOLD);
    this.relationThreshold = options.relationThreshold
      ?? (Number.isFinite(envThreshold) ? envThreshold : 0.5);
    this.fallbackPerRelationLimit = options.fallbackPerRelationLimit ?? 50;
  }

  async enumerate(plan: EnumerationPlan, limit = 1000): Promise<EnumerationResult> {
    const anchors = [...new Set(plan.anchors.map(anchor => anchor.trim()).filter(Boolean))];
    if (anchors.length === 0 || limit <= 0) {
      return { answers: [], truncated: false, fallbackUsed: false };
    }

    const direction = plan.direction ?? 'both';
    const perAnchor = new Map<string, Map<string, EnumerationAnswer>>();
    let fallbackUsed = false;

    for (const anchor of anchors) {
      const seededTriples = await this.collectAnchorTriples(anchor, direction, limit);
      const filtered = await this.applyRelationFilter(seededTriples, plan.relationText);
      fallbackUsed ||= filtered.fallbackUsed;
      perAnchor.set(anchor, this.projectAnswers(direction, filtered.triples));
    }

    const requiredAnchors = anchors.length;
    const merged = new Map<string, EnumerationAnswer & { anchorCount: number }>();
    for (const answers of perAnchor.values()) {
      for (const [normalizedEntity, answer] of answers) {
        const existing = merged.get(normalizedEntity);
        if (!existing) {
          merged.set(normalizedEntity, { ...answer, anchorCount: 1 });
          continue;
        }
        existing.anchorCount++;
        this.mergeAnswer(existing, answer);
      }
    }

    const keepAll = plan.setMode === 'union';
    const answers = Array.from(merged.values())
      .filter(answer => keepAll || answer.anchorCount === requiredAnchors)
      .map(({ anchorCount: _anchorCount, ...answer }) => answer)
      .sort((a, b) => a.entity.localeCompare(b.entity));

    const truncated = answers.length > limit;
    return {
      answers: answers.slice(0, limit),
      truncated,
      fallbackUsed,
    };
  }

  private async collectAnchorTriples(anchor: string, direction: Direction, limit: number): Promise<SeededTriple[]> {
    const bySeedAndId = new Map<string, SeededTriple>();
    const add = (seed: string, triples: GraphTriple[]) => {
      for (const triple of triples) {
        bySeedAndId.set(`${normalizeEntity(seed)}\0${triple.id}`, { seed, triple });
      }
    };

    add(anchor, await this.graphStore.findTriplesByEntity(anchor, direction, limit));

    const related = await this.graphStore.findRelatedEntities(anchor);
    const aliases = new Set<string>();
    for (const triple of related) {
      if (triple.subject.trim()) aliases.add(triple.subject);
      if (triple.object.trim()) aliases.add(triple.object);
    }

    for (const alias of aliases) {
      add(alias, await this.graphStore.findTriplesByEntity(alias, direction, limit));
    }

    return Array.from(bySeedAndId.values());
  }

  private async applyRelationFilter(
    seededTriples: SeededTriple[],
    relationText?: string,
  ): Promise<{ triples: SeededTriple[]; fallbackUsed: boolean }> {
    const triples = seededTriples.map(item => item.triple);
    if (triples.length === 0) return { triples: [], fallbackUsed: false };
    if (!relationText || relationText.trim() === '') {
      return { triples: this.fallbackTriples(seededTriples), fallbackUsed: true };
    }

    try {
      const queryVector = await this.embedder.embed(relationText, 'query');
      const relationVectors = new Map<string, number[]>();
      const filtered: SeededTriple[] = [];

      for (const item of seededTriples) {
        const triple = item.triple;
        let relationVector = relationVectors.get(triple.relation);
        if (!relationVector) {
          relationVector = await this.embedder.embed(triple.relation, 'query');
          relationVectors.set(triple.relation, relationVector);
        }
        if (cosineSimilarity(queryVector, relationVector) >= this.relationThreshold) {
          filtered.push(item);
        }
      }

      if (filtered.length > 0) return { triples: filtered, fallbackUsed: false };
    } catch {
      // Fall through to deterministic fallback on embedding failures.
    }

    return { triples: this.fallbackTriples(seededTriples), fallbackUsed: true };
  }

  private fallbackTriples(seededTriples: SeededTriple[]): SeededTriple[] {
    const byRelation = new Map<string, SeededTriple[]>();
    for (const item of [...seededTriples].sort((a, b) => stableTripleCompare(a.triple, b.triple))) {
      const triple = item.triple;
      const group = byRelation.get(triple.relation) ?? [];
      if (group.length < this.fallbackPerRelationLimit) {
        group.push(item);
        byRelation.set(triple.relation, group);
      }
    }
    return Array.from(byRelation.keys())
      .sort()
      .flatMap(relation => byRelation.get(relation) ?? []);
  }

  private projectAnswers(direction: Direction, seededTriples: SeededTriple[]): Map<string, EnumerationAnswer> {
    const projected: ProjectedTriple[] = [];

    for (const item of seededTriples) {
      const triple = item.triple;
      const normalizedSeed = normalizeEntity(item.seed);
      const subjectMatches = normalizeEntity(triple.subject) === normalizedSeed;
      const objectMatches = normalizeEntity(triple.object) === normalizedSeed;

      if ((direction === 'out' || direction === 'both') && subjectMatches) {
        projected.push({ entity: triple.object, normalizedEntity: normalizeEntity(triple.object), triple });
      }
      if ((direction === 'in' || direction === 'both') && objectMatches) {
        projected.push({ entity: triple.subject, normalizedEntity: normalizeEntity(triple.subject), triple });
      }
    }

    const answers = new Map<string, EnumerationAnswer>();
    for (const item of projected) {
      if (!item.normalizedEntity) continue;
      const answer = answers.get(item.normalizedEntity) ?? {
        entity: item.entity,
        evidenceTriples: [],
        sourceMemoryIds: [],
      };
      if (!answer.evidenceTriples.some(triple => triple.id === item.triple.id)) {
        answer.evidenceTriples.push(item.triple);
      }
      if (item.triple.sourceMemoryId && !answer.sourceMemoryIds.includes(item.triple.sourceMemoryId)) {
        answer.sourceMemoryIds.push(item.triple.sourceMemoryId);
      }
      answers.set(item.normalizedEntity, answer);
    }
    return answers;
  }

  private mergeAnswer(target: EnumerationAnswer, source: EnumerationAnswer): void {
    for (const triple of source.evidenceTriples) {
      if (!target.evidenceTriples.some(existing => existing.id === triple.id)) {
        target.evidenceTriples.push(triple);
      }
    }
    for (const id of source.sourceMemoryIds) {
      if (!target.sourceMemoryIds.includes(id)) target.sourceMemoryIds.push(id);
    }
  }
}
