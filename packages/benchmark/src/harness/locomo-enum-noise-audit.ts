#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EnumerationPlan, MemorySearchResult } from '@memory-river/core';

import { buildEnumerationPlan } from './enumeration-plan.js';
import { loadLocomo, type LocomoConversation } from './locomo.js';
import {
  buildEvidenceEntryMap,
  evidenceDiaIds,
  findSnapshotPath,
  type GraphTripleRow,
  type MemoryRow,
  readLanceRows,
  sourceEntryIds,
} from './locomo-provenance.js';
import { createRealEmbedder } from './real-embedder.js';
import { createRealMemoryRiver } from './real-river.js';

type Direction = 'out' | 'in' | 'both';
type Provenance = 'exact-anchor' | 'ann-alias';
type AliasEndpoint = 'subject' | 'object';

const ENUMERATION_LIMIT = 1000;
const ANN_LIMIT = 10;
const DEFAULT_RELATION_THRESHOLD = 0.5;

interface AuditOptions {
  snapshotDir?: string;
  conversation?: string;
  category: number;
  k: number;
  json?: boolean;
  relationTable?: boolean;
}

interface LanceGraphTripleRow extends GraphTripleRow {
  createdAt?: number;
  _distance?: number;
}

interface MemoryWithEntries extends MemoryRow {
  sourceEntryIds: number[];
}

interface SeededTriple {
  anchor: string;
  seed: string;
  triple: LanceGraphTripleRow;
  provenance: Provenance;
  alias?: string;
  aliasEndpoint?: AliasEndpoint;
  annTripleId?: string;
  annDistance: number | null;
  relationCosine: number | null;
  relationPass: boolean | null;
}

interface ProjectedTriple extends SeededTriple {
  entity: string;
  normalizedEntity: string;
  gold: boolean;
  memorySourceEntryIds: number[];
}

interface CandidateMemory {
  rank: number;
  entity: string;
  memoryId: string;
  sourceEntryIds: number[];
  gold: boolean;
  provenance: 'exact-anchor' | 'ann-alias' | 'mixed';
  triples: ProjectedTriple[];
}

interface QuestionAudit {
  sampleId: string;
  questionIndex: number;
  category: number;
  question: string;
  plan?: EnumerationPlan;
  plannerSkipped: boolean;
  fallbackUsed: boolean;
  goldEntryIds: number[];
  returned: CandidateMemory[];
  aliasFanout: AliasFanoutRecord[];
}

interface AliasFanoutRecord {
  sampleId: string;
  questionIndex: number;
  anchor: string;
  alias: string;
  aliasEndpoint: AliasEndpoint;
  annTripleId: string;
  annDistance: number | null;
  triplesPulled: number;
  goldTriples: number;
  contributesGold: boolean;
}

interface QuantileSummary {
  count: number;
  min: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  max: number | null;
}

interface ProvenanceSplit {
  total: number;
  gold: {
    total: number;
    exactAnchor: number;
    annAlias: number;
    mixed: number;
    exactAnchorFraction: number;
    annAliasFraction: number;
    mixedFraction: number;
  };
  noise: {
    total: number;
    exactAnchor: number;
    annAlias: number;
    mixed: number;
    exactAnchorFraction: number;
    annAliasFraction: number;
    mixedFraction: number;
  };
}

interface AliasFanoutSummary {
  aliases: number;
  meanTriplesPulled: number;
  p95TriplesPulled: number;
  maxTriplesPulled: number;
  aliasesWithAnyGold: number;
  goldYieldPerAlias: number;
}

interface GateCurvePoint {
  gate: string;
  setting: string;
  goldKeptFraction: number;
  noiseRemovedFraction: number;
  goldKept: number;
  goldBaseline: number;
  noiseRemoved: number;
  noiseBaseline: number;
}

interface AuditResult {
  metricLabel: string;
  conversations: number;
  category: number;
  k: number;
  questions: number;
  scoredQuestions: number;
  provenanceSplit: ProvenanceSplit;
  annDistance: {
    gold: QuantileSummary;
    noise: QuantileSummary;
  };
  relationCosine: {
    gold: QuantileSummary;
    noise: QuantileSummary;
  };
  aliasFanout: AliasFanoutSummary;
  counterfactualGateCurves: GateCurvePoint[];
  questionAudits: QuestionAudit[];
  warnings: string[];
}

interface RelationContingencyRow {
  relation: string;
  goldMemories: number;
  noiseMemories: number;
  precision: number;
  questionsUsingIt: number;
}

interface RelationOracleMetrics {
  siblingRecallAt10: number;
  siblingRecallAt50: number;
  noiseAt10: number;
  oracleRelationsPerQuestionMean: number;
  goldProjMemKept: number;
  goldProjMemEligible: number;
  noiseProjMemKept: number;
  noiseProjMemEligible: number;
  survivorNoiseGoldRatioMean: number;
  survivorNoiseGoldRatioP50: number;
}

interface RelationProbeAblationResult {
  label: 'full-fanout' | 'exact-only';
  contingency: RelationContingencyRow[];
  oracle: RelationOracleMetrics;
}

interface RelationProbeQuestion {
  sampleId: string;
  questionIndex: number;
  plannerSkipped: boolean;
  goldEntryIds: number[];
  oracleRelations: string[];
  eligible: CandidateMemory[];
  kept: CandidateMemory[];
  returnedAt10: CandidateMemory[];
  returnedAt50: CandidateMemory[];
}

interface RelationProbeResult {
  metricLabel: string;
  conversations: number;
  category: number;
  questions: number;
  scoredQuestions: number;
  ablations: RelationProbeAblationResult[];
  parityCheck: {
    sampleId: string;
    questionIndex: number;
    matched: boolean;
    retraceMemoryIds: string[];
    productionMemoryIds: string[];
  } | null;
  warnings: string[];
}

interface TraceContext {
  table: any;
  embedder: { embed(text: string, mode?: 'store' | 'query'): Promise<number[]> };
  memoriesById: Map<string, MemoryWithEntries>;
  relationThreshold: number;
}

function usage(): void {
  console.error(
    'Usage: mr-bench locomo-enum-noise-audit --snapshot-dir DIR ' +
    '[--conversation conv-26] [--category 1] [--k 50] [--relation-table] [--json]',
  );
}

function parsePositiveInteger(option: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} requires a positive integer`);
  }
  return parsed;
}

function parseArgs(args: string[]): AuditOptions {
  const options: AuditOptions = { category: 1, k: 50 };
  const rest = [...args];
  while (rest.length > 0) {
    const option = rest.shift();
    if (option === '--snapshot-dir') {
      options.snapshotDir = rest.shift();
      if (!options.snapshotDir || options.snapshotDir.startsWith('--')) {
        throw new Error('--snapshot-dir requires a directory path');
      }
    } else if (option === '--conversation') {
      options.conversation = rest.shift();
      if (!options.conversation || options.conversation.startsWith('--')) {
        throw new Error('--conversation requires a LoCoMo sample id such as conv-26');
      }
    } else if (option === '--category') {
      options.category = parsePositiveInteger(option, rest.shift());
    } else if (option === '--k') {
      options.k = parsePositiveInteger(option, rest.shift());
    } else if (option === '--json') {
      options.json = true;
    } else if (option === '--relation-table') {
      options.relationTable = true;
    } else if (option === '--help' || option === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${option}`);
    }
  }
  return options;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function quantileSummary(values: number[]): QuantileSummary {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p10: quantile(sorted, 0.10),
    p50: quantile(sorted, 0.50),
    p90: quantile(sorted, 0.90),
    max: sorted[sorted.length - 1] ?? null,
  };
}

function formatNumber(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4);
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeEntity(entity: string): string {
  return entity.trim().toLocaleLowerCase();
}

function normalizeSurface(entity: string): string {
  return normalizeEntity(entity).replace(/[^\p{L}\p{N}]+/gu, '');
}

function endpointIsSurfaceVariant(anchor: string, endpoint: string): boolean {
  const normalizedAnchor = normalizeSurface(anchor);
  const normalizedEndpoint = normalizeSurface(endpoint);
  if (!normalizedAnchor || !normalizedEndpoint) return false;
  return normalizedAnchor === normalizedEndpoint
    || normalizedAnchor.includes(normalizedEndpoint)
    || normalizedEndpoint.includes(normalizedAnchor);
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

function stableTripleCompare(a: LanceGraphTripleRow, b: LanceGraphTripleRow): number {
  return a.relation.localeCompare(b.relation)
    || a.object.localeCompare(b.object)
    || a.subject.localeCompare(b.subject)
    || a.id.localeCompare(b.id);
}

function parseMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata !== 'string' || metadata.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isActiveMemory(row: MemoryRow): boolean {
  const topStatus = row.status || 'active';
  const metaStatus = parseMetadata(row.metadata).status;
  return topStatus === 'active' && (metaStatus == null || metaStatus === 'active');
}

function goldEntryIdsForQuestion(
  conversation: LocomoConversation,
  snapshotPath: string,
  evidence: string[],
): number[] {
  const evidenceEntryMap = buildEvidenceEntryMap(conversation, snapshotPath);
  return uniqueNumbers(evidence.flatMap(item =>
    evidenceDiaIds(item)
      .map(diaId => evidenceEntryMap.get(diaId)?.entryId)
      .filter((entryId): entryId is number => entryId !== undefined)
  ));
}

async function openGraphTriplesTable(snapshotPath: string): Promise<any> {
  const lancedb = await import('@lancedb/lancedb');
  const ramPath = path.join(snapshotPath, 'ram');
  const dataPath = path.join(snapshotPath, 'data', 'lancedb');
  const dbPath = fs.existsSync(path.join(ramPath, 'graph_triples.lance')) ? ramPath : dataPath;
  const db = await lancedb.connect(dbPath);
  return await db.openTable('graph_triples');
}

async function loadMemories(snapshotPath: string): Promise<Map<string, MemoryWithEntries>> {
  const memories = (await readLanceRows<MemoryRow>(
    snapshotPath,
    'memories',
    ['id', 'text', 'metadata', 'category', 'status'],
  )).filter(row => row.id !== 'init_00000000000000000000000000000000' && isActiveMemory(row));

  return new Map(memories.map(row => [row.id, {
    ...row,
    sourceEntryIds: sourceEntryIds(row.metadata),
  }]));
}

async function findTriplesByEntity(
  table: any,
  entity: string,
  direction: Direction,
  limit: number,
): Promise<LanceGraphTripleRow[]> {
  if (!entity.trim()) return [];
  const columns = ['id', 'subject', 'relation', 'object', 'sourceMemoryId', 'createdAt'];
  const literal = escapeSqlString(entity);
  const rowsFor = async (field: 'subject' | 'object'): Promise<LanceGraphTripleRow[]> =>
    await table.query()
      .select(columns)
      .where(`${field} = '${literal}'`)
      .limit(limit)
      .toArray() as LanceGraphTripleRow[];

  if (direction === 'out') {
    return (await rowsFor('subject')).filter(row => !row.id.startsWith('init_'));
  }
  if (direction === 'in') {
    return (await rowsFor('object')).filter(row => !row.id.startsWith('init_'));
  }

  const byId = new Map<string, LanceGraphTripleRow>();
  for (const triple of await rowsFor('subject')) {
    if (!triple.id.startsWith('init_')) byId.set(triple.id, triple);
  }
  for (const triple of await rowsFor('object')) {
    if (!triple.id.startsWith('init_')) byId.set(triple.id, triple);
  }
  return Array.from(byId.values()).slice(0, limit);
}

async function findRelatedEntitiesWithDistance(
  table: any,
  embedder: { embed(text: string, mode?: 'store' | 'query'): Promise<number[]> },
  anchor: string,
): Promise<LanceGraphTripleRow[]> {
  if (!anchor.trim()) return [];
  const queryVector = await embedder.embed(anchor);
  if (queryVector.length === 0) return [];
  return (await table.search(queryVector).limit(ANN_LIMIT).toArray() as LanceGraphTripleRow[])
    .filter(row => !row.id.startsWith('init_'));
}

async function collectAnchorTriples(
  context: TraceContext,
  anchor: string,
  direction: Direction,
  includeAnnAliases = true,
): Promise<{ triples: SeededTriple[]; aliasFanout: AliasFanoutRecord[] }> {
  const bySeedAndId = new Map<string, SeededTriple>();
  const aliasFanout: AliasFanoutRecord[] = [];
  const add = (
    seed: string,
    triples: LanceGraphTripleRow[],
    provenance: Provenance,
    aliasMeta?: Pick<SeededTriple, 'alias' | 'aliasEndpoint' | 'annTripleId' | 'annDistance'>,
  ) => {
    for (const triple of triples) {
      bySeedAndId.set(`${normalizeEntity(seed)}\0${triple.id}`, {
        anchor,
        seed,
        triple,
        provenance,
        annDistance: null,
        relationCosine: null,
        relationPass: null,
        ...aliasMeta,
      });
    }
  };

  add(anchor, await findTriplesByEntity(context.table, anchor, direction, ENUMERATION_LIMIT), 'exact-anchor');
  if (!includeAnnAliases) return { triples: Array.from(bySeedAndId.values()), aliasFanout };

  const related = await findRelatedEntitiesWithDistance(context.table, context.embedder, anchor);
  const aliases = new Map<string, {
    alias: string;
    aliasEndpoint: AliasEndpoint;
    annTripleId: string;
    annDistance: number | null;
  }>();
  for (const triple of related) {
    const annDistance = numberOrNull(triple._distance);
    if (triple.subject.trim() && !aliases.has(triple.subject)) {
      aliases.set(triple.subject, {
        alias: triple.subject,
        aliasEndpoint: 'subject',
        annTripleId: triple.id,
        annDistance,
      });
    }
    if (triple.object.trim() && !aliases.has(triple.object)) {
      aliases.set(triple.object, {
        alias: triple.object,
        aliasEndpoint: 'object',
        annTripleId: triple.id,
        annDistance,
      });
    }
  }

  for (const alias of aliases.values()) {
    const triples = await findTriplesByEntity(context.table, alias.alias, direction, ENUMERATION_LIMIT);
    add(alias.alias, triples, 'ann-alias', alias);
    aliasFanout.push({
      sampleId: '',
      questionIndex: -1,
      anchor,
      alias: alias.alias,
      aliasEndpoint: alias.aliasEndpoint,
      annTripleId: alias.annTripleId,
      annDistance: alias.annDistance,
      triplesPulled: triples.length,
      goldTriples: 0,
      contributesGold: false,
    });
  }

  return { triples: Array.from(bySeedAndId.values()), aliasFanout };
}

async function applyRelationScores(
  context: TraceContext,
  seededTriples: SeededTriple[],
  relationText?: string,
  threshold = context.relationThreshold,
): Promise<{ triples: SeededTriple[]; fallbackUsed: boolean }> {
  if (seededTriples.length === 0) return { triples: [], fallbackUsed: false };
  if (!relationText || relationText.trim() === '') {
    return { triples: fallbackTriples(seededTriples), fallbackUsed: true };
  }

  const queryVector = await context.embedder.embed(relationText, 'query');
  const relationVectors = new Map<string, number[]>();
  const scored: SeededTriple[] = [];
  for (const item of seededTriples) {
    let relationVector = relationVectors.get(item.triple.relation);
    if (!relationVector) {
      relationVector = await context.embedder.embed(item.triple.relation, 'query');
      relationVectors.set(item.triple.relation, relationVector);
    }
    const relationCosine = cosineSimilarity(queryVector, relationVector);
    scored.push({
      ...item,
      relationCosine,
      relationPass: relationCosine >= threshold,
    });
  }

  const filtered = scored.filter(item => item.relationPass);
  if (filtered.length > 0) return { triples: filtered, fallbackUsed: false };
  return { triples: fallbackTriples(scored), fallbackUsed: true };
}

function fallbackTriples(seededTriples: SeededTriple[]): SeededTriple[] {
  const byRelation = new Map<string, SeededTriple[]>();
  for (const item of [...seededTriples].sort((a, b) => stableTripleCompare(a.triple, b.triple))) {
    const group = byRelation.get(item.triple.relation) ?? [];
    if (group.length < 50) {
      group.push(item);
      byRelation.set(item.triple.relation, group);
    }
  }
  return Array.from(byRelation.keys())
    .sort()
    .flatMap(relation => byRelation.get(relation) ?? []);
}

function projectAnswers(
  direction: Direction,
  seededTriples: SeededTriple[],
  memoriesById: Map<string, MemoryWithEntries>,
  goldSet: Set<number>,
  k: number,
): CandidateMemory[] {
  const projected: ProjectedTriple[] = [];
  for (const item of seededTriples) {
    const normalizedSeed = normalizeEntity(item.seed);
    const subjectMatches = normalizeEntity(item.triple.subject) === normalizedSeed;
    const objectMatches = normalizeEntity(item.triple.object) === normalizedSeed;
    const memory = memoriesById.get(item.triple.sourceMemoryId);
    if (!memory) continue;

    const push = (entity: string) => {
      const memorySourceEntryIds = memory.sourceEntryIds;
      projected.push({
        ...item,
        entity,
        normalizedEntity: normalizeEntity(entity),
        gold: memorySourceEntryIds.some(entryId => goldSet.has(entryId)),
        memorySourceEntryIds,
      });
    };

    if ((direction === 'out' || direction === 'both') && subjectMatches) push(item.triple.object);
    if ((direction === 'in' || direction === 'both') && objectMatches) push(item.triple.subject);
  }

  const answers = new Map<string, {
    entity: string;
    evidenceTriples: ProjectedTriple[];
    sourceMemoryIds: string[];
  }>();
  for (const item of projected) {
    if (!item.normalizedEntity) continue;
    const answer = answers.get(item.normalizedEntity) ?? {
      entity: item.entity,
      evidenceTriples: [],
      sourceMemoryIds: [],
    };
    if (!answer.evidenceTriples.some(existing => existing.triple.id === item.triple.id)) {
      answer.evidenceTriples.push(item);
    }
    if (item.triple.sourceMemoryId && !answer.sourceMemoryIds.includes(item.triple.sourceMemoryId)) {
      answer.sourceMemoryIds.push(item.triple.sourceMemoryId);
    }
    answers.set(item.normalizedEntity, answer);
  }

  const candidates: CandidateMemory[] = [];
  const seen = new Set<string>();
  const sortedAnswers = Array.from(answers.values())
    .sort((left, right) => left.entity.localeCompare(right.entity));
  for (const answer of sortedAnswers) {
    for (const memoryId of answer.sourceMemoryIds) {
      if (seen.has(memoryId)) continue;
      const memory = memoriesById.get(memoryId);
      if (!memory) continue;
      seen.add(memoryId);
      const triples = answer.evidenceTriples.filter(item => item.triple.sourceMemoryId === memoryId);
      const provenances = new Set(triples.map(item => item.provenance));
      candidates.push({
        rank: candidates.length + 1,
        entity: answer.entity,
        memoryId,
        sourceEntryIds: memory.sourceEntryIds,
        gold: memory.sourceEntryIds.some(entryId => goldSet.has(entryId)),
        provenance: provenances.size > 1
          ? 'mixed'
          : (provenances.has('exact-anchor') ? 'exact-anchor' : 'ann-alias'),
        triples,
      });
      if (candidates.length >= k) return candidates;
    }
  }
  return candidates;
}

function mergePlanResults(
  plan: EnumerationPlan,
  perAnchor: CandidateMemory[][],
  memoriesById: Map<string, MemoryWithEntries>,
  goldSet: Set<number>,
  k: number,
): CandidateMemory[] {
  const requiredAnchors = perAnchor.length;
  const byEntity = new Map<string, {
    entity: string;
    anchorCount: number;
    sourceMemoryIds: string[];
    triplesByMemoryId: Map<string, ProjectedTriple[]>;
  }>();

  for (const candidates of perAnchor) {
    const entitiesSeenForAnchor = new Set<string>();
    for (const candidate of candidates) {
      const normalizedEntity = normalizeEntity(candidate.entity);
      const group = byEntity.get(normalizedEntity) ?? {
        entity: candidate.entity,
        anchorCount: 0,
        sourceMemoryIds: [],
        triplesByMemoryId: new Map<string, ProjectedTriple[]>(),
      };
      if (!entitiesSeenForAnchor.has(normalizedEntity)) {
        group.anchorCount++;
        entitiesSeenForAnchor.add(normalizedEntity);
      }
      if (!group.sourceMemoryIds.includes(candidate.memoryId)) {
        group.sourceMemoryIds.push(candidate.memoryId);
      }
      const triples = group.triplesByMemoryId.get(candidate.memoryId) ?? [];
      for (const triple of candidate.triples) {
        if (!triples.some(existing => existing.triple.id === triple.triple.id)) triples.push(triple);
      }
      group.triplesByMemoryId.set(candidate.memoryId, triples);
      byEntity.set(normalizedEntity, group);
    }
  }

  const keepAll = plan.setMode === 'union';
  const returned: CandidateMemory[] = [];
  for (const group of [...byEntity.values()]
    .filter(item => keepAll || item.anchorCount === requiredAnchors)
    .sort((left, right) => left.entity.localeCompare(right.entity))) {
    for (const memoryId of group.sourceMemoryIds) {
      const memory = memoriesById.get(memoryId);
      if (!memory) continue;
      const triples = group.triplesByMemoryId.get(memoryId) ?? [];
      const provenances = new Set(triples.map(item => item.provenance));
      returned.push({
        rank: returned.length + 1,
        entity: group.entity,
        memoryId,
        sourceEntryIds: memory.sourceEntryIds,
        gold: memory.sourceEntryIds.some(entryId => goldSet.has(entryId)),
        provenance: provenances.size > 1
          ? 'mixed'
          : (provenances.has('exact-anchor') ? 'exact-anchor' : 'ann-alias'),
        triples,
      });
      if (returned.length >= k) return returned;
    }
  }
  return returned;
}

function baselineCounts(questions: QuestionAudit[]): { gold: Set<string>; noise: Set<string> } {
  const gold = new Set<string>();
  const noise = new Set<string>();
  for (const question of questions) {
    for (const candidate of question.returned) {
      const key = `${question.sampleId}\0${question.questionIndex}\0${candidate.memoryId}`;
      (candidate.gold ? gold : noise).add(key);
    }
  }
  return { gold, noise };
}

function curvePoint(
  gate: string,
  setting: string,
  baseline: { gold: Set<string>; noise: Set<string> },
  kept: Set<string>,
): GateCurvePoint {
  let goldKept = 0;
  let noiseKept = 0;
  for (const key of baseline.gold) if (kept.has(key)) goldKept++;
  for (const key of baseline.noise) if (kept.has(key)) noiseKept++;
  const noiseRemoved = baseline.noise.size - noiseKept;
  return {
    gate,
    setting,
    goldKeptFraction: baseline.gold.size > 0 ? goldKept / baseline.gold.size : 0,
    noiseRemovedFraction: baseline.noise.size > 0 ? noiseRemoved / baseline.noise.size : 0,
    goldKept,
    goldBaseline: baseline.gold.size,
    noiseRemoved,
    noiseBaseline: baseline.noise.size,
  };
}

function candidateKeys(questions: QuestionAudit[], mutate: (triple: ProjectedTriple) => boolean): Set<string> {
  const kept = new Set<string>();
  for (const question of questions) {
    for (const candidate of question.returned) {
      if (candidate.triples.some(mutate)) {
        kept.add(`${question.sampleId}\0${question.questionIndex}\0${candidate.memoryId}`);
      }
    }
  }
  return kept;
}

function buildCounterfactualCurves(questions: QuestionAudit[]): GateCurvePoint[] {
  const baseline = baselineCounts(questions);
  const points: GateCurvePoint[] = [];
  const annDistances = questions
    .flatMap(question => question.returned)
    .flatMap(candidate => candidate.triples)
    .map(triple => triple.annDistance)
    .filter((value): value is number => value !== null);
  const distanceThresholds = uniqueNumbers([
    ...annDistances.map(value => Number(value.toFixed(6))),
    ...[quantile(annDistances, 0.10), quantile(annDistances, 0.50), quantile(annDistances, 0.90)]
      .filter((value): value is number => value !== null)
      .map(value => Number(value.toFixed(6))),
  ]).slice(0, 12);

  for (const threshold of distanceThresholds) {
    points.push(curvePoint(
      'ann-distance',
      `<=${threshold}`,
      baseline,
      candidateKeys(questions, triple =>
        triple.provenance === 'exact-anchor' || (triple.annDistance !== null && triple.annDistance <= threshold),
      ),
    ));
  }

  for (const threshold of [0.4, 0.5, 0.6, 0.7]) {
    points.push(curvePoint(
      'relation-threshold',
      `>=${threshold}`,
      baseline,
      candidateKeys(questions, triple => triple.relationCosine === null || triple.relationCosine >= threshold),
    ));
  }

  points.push(curvePoint(
    'alias-endpoint-rule',
    'surface-variant-only',
    baseline,
    candidateKeys(questions, triple =>
      triple.provenance === 'exact-anchor'
      || !triple.alias
      || endpointIsSurfaceVariant(triple.anchor, triple.alias),
    ),
  ));

  for (const cap of [1, 3, 5, 10]) {
    points.push(curvePoint(
      'per-alias-cap',
      String(cap),
      baseline,
      candidateKeys(questions, triple => {
        if (triple.provenance === 'exact-anchor') return true;
        const sortedForAlias = questions
          .flatMap(question => question.returned)
          .flatMap(candidate => candidate.triples)
          .filter(item => item.alias === triple.alias && item.annTripleId === triple.annTripleId)
          .sort((left, right) => stableTripleCompare(left.triple, right.triple));
        return sortedForAlias.findIndex(item => item.triple.id === triple.triple.id) < cap;
      }),
    ));
  }

  return points;
}

function provenanceSplit(candidates: CandidateMemory[]): ProvenanceSplit {
  const empty = () => ({
    total: 0,
    exactAnchor: 0,
    annAlias: 0,
    mixed: 0,
    exactAnchorFraction: 0,
    annAliasFraction: 0,
    mixedFraction: 0,
  });
  const gold = empty();
  const noise = empty();
  for (const candidate of candidates) {
    const bucket = candidate.gold ? gold : noise;
    bucket.total++;
    if (candidate.provenance === 'exact-anchor') bucket.exactAnchor++;
    else if (candidate.provenance === 'ann-alias') bucket.annAlias++;
    else bucket.mixed++;
  }
  for (const bucket of [gold, noise]) {
    bucket.exactAnchorFraction = bucket.total > 0 ? bucket.exactAnchor / bucket.total : 0;
    bucket.annAliasFraction = bucket.total > 0 ? bucket.annAlias / bucket.total : 0;
    bucket.mixedFraction = bucket.total > 0 ? bucket.mixed / bucket.total : 0;
  }
  return { total: candidates.length, gold, noise };
}

function summarizeAliasFanout(records: AliasFanoutRecord[]): AliasFanoutSummary {
  const counts = records.map(record => record.triplesPulled);
  const aliasesWithAnyGold = records.filter(record => record.contributesGold).length;
  return {
    aliases: records.length,
    meanTriplesPulled: mean(counts),
    p95TriplesPulled: quantile(counts, 0.95) ?? 0,
    maxTriplesPulled: counts.length > 0 ? Math.max(...counts) : 0,
    aliasesWithAnyGold,
    goldYieldPerAlias: records.length > 0 ? aliasesWithAnyGold / records.length : 0,
  };
}

async function traceQuestion(
  context: TraceContext,
  conversation: LocomoConversation,
  snapshotPath: string,
  questionIndex: number,
  qa: LocomoConversation['qa'][number],
  k: number,
): Promise<QuestionAudit> {
  const goldEntryIds = goldEntryIdsForQuestion(conversation, snapshotPath, qa.evidence);
  const goldSet = new Set(goldEntryIds);
  const planResult = buildEnumerationPlan(qa.question, conversation);
  if (planResult.plannerSkipped || !planResult.plan) {
    return {
      sampleId: conversation.sampleId,
      questionIndex,
      category: qa.category,
      question: qa.question,
      plannerSkipped: true,
      fallbackUsed: false,
      goldEntryIds,
      returned: [],
      aliasFanout: [],
    };
  }

  const plan = planResult.plan;
  const direction = plan.direction ?? 'both';
  const perAnchorCandidates: CandidateMemory[][] = [];
  const aliasFanout: AliasFanoutRecord[] = [];
  let fallbackUsed = false;
  for (const anchor of [...new Set(plan.anchors.map(item => item.trim()).filter(Boolean))]) {
    const collected = await collectAnchorTriples(context, anchor, direction);
    const filtered = await applyRelationScores(
      context,
      collected.triples,
      plan.relationText,
      context.relationThreshold,
    );
    fallbackUsed ||= filtered.fallbackUsed;
    const candidates = projectAnswers(
      direction,
      filtered.triples,
      context.memoriesById,
      goldSet,
      Number.MAX_SAFE_INTEGER,
    );
    perAnchorCandidates.push(candidates);

    for (const record of collected.aliasFanout) {
      const aliasTriples = filtered.triples.filter(item =>
        item.provenance === 'ann-alias'
        && item.alias === record.alias
        && item.annTripleId === record.annTripleId
      );
      record.sampleId = conversation.sampleId;
      record.questionIndex = questionIndex;
      record.goldTriples = aliasTriples.filter(item => {
        const memory = context.memoriesById.get(item.triple.sourceMemoryId);
        return (memory?.sourceEntryIds ?? []).some(entryId => goldSet.has(entryId));
      }).length;
      record.contributesGold = record.goldTriples > 0;
      aliasFanout.push(record);
    }
  }

  const returned = mergePlanResults(plan, perAnchorCandidates, context.memoriesById, goldSet, k);

  return {
    sampleId: conversation.sampleId,
    questionIndex,
    category: qa.category,
    question: qa.question,
    plan,
    plannerSkipped: false,
    fallbackUsed,
    goldEntryIds,
    returned,
    aliasFanout,
  };
}

function relationProbePlan(plan: EnumerationPlan): EnumerationPlan {
  return { ...plan, direction: 'out' };
}

async function collectProjectedCandidatesForPlan(
  context: TraceContext,
  plan: EnumerationPlan,
  goldSet: Set<number>,
  includeAnnAliases: boolean,
  keepTriple: (triple: SeededTriple) => boolean,
): Promise<CandidateMemory[]> {
  const direction = plan.direction ?? 'both';
  const perAnchorCandidates: CandidateMemory[][] = [];
  for (const anchor of [...new Set(plan.anchors.map(item => item.trim()).filter(Boolean))]) {
    const collected = await collectAnchorTriples(context, anchor, direction, includeAnnAliases);
    const candidates = projectAnswers(
      direction,
      collected.triples.filter(keepTriple),
      context.memoriesById,
      goldSet,
      Number.MAX_SAFE_INTEGER,
    );
    perAnchorCandidates.push(candidates);
  }
  return mergePlanResults(plan, perAnchorCandidates, context.memoriesById, goldSet, Number.MAX_SAFE_INTEGER);
}

async function collectCosineFilteredCandidatesForPlan(
  context: TraceContext,
  plan: EnumerationPlan,
  goldSet: Set<number>,
  includeAnnAliases: boolean,
  k: number,
): Promise<CandidateMemory[]> {
  const direction = plan.direction ?? 'both';
  const perAnchorCandidates: CandidateMemory[][] = [];
  for (const anchor of [...new Set(plan.anchors.map(item => item.trim()).filter(Boolean))]) {
    const collected = await collectAnchorTriples(context, anchor, direction, includeAnnAliases);
    const filtered = await applyRelationScores(
      context,
      collected.triples,
      plan.relationText,
      context.relationThreshold,
    );
    perAnchorCandidates.push(projectAnswers(
      direction,
      filtered.triples,
      context.memoriesById,
      goldSet,
      Number.MAX_SAFE_INTEGER,
    ));
  }
  return mergePlanResults(plan, perAnchorCandidates, context.memoriesById, goldSet, k);
}

function coveredGoldEntryIdsFromCandidates(candidates: CandidateMemory[], goldEntryIds: Set<number>): number[] {
  const covered = new Set<number>();
  for (const candidate of candidates) {
    for (const entryId of candidate.sourceEntryIds) {
      if (goldEntryIds.has(entryId)) covered.add(entryId);
    }
  }
  return uniqueNumbers([...covered]);
}

function noiseFractionAtK(candidates: CandidateMemory[], k: number): number {
  const top = candidates.slice(0, k);
  return top.length > 0 ? top.filter(candidate => !candidate.gold).length / top.length : 0;
}

function memoryIdsFromResults(results: MemorySearchResult[]): string[] {
  return results.map(result => result.entry.id);
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every(item => rightSet.has(item));
}

async function parityCheckQuestion(
  conversation: LocomoConversation,
  snapshotPath: string,
  qa: LocomoConversation['qa'][number],
  questionIndex: number,
): Promise<RelationProbeResult['parityCheck']> {
  const context: TraceContext = {
    table: await openGraphTriplesTable(snapshotPath),
    embedder: createRealEmbedder(),
    memoriesById: await loadMemories(snapshotPath),
    relationThreshold: DEFAULT_RELATION_THRESHOLD,
  };
  const planResult = buildEnumerationPlan(qa.question, conversation);
  if (planResult.plannerSkipped || !planResult.plan) return null;

  const plan = relationProbePlan(planResult.plan);
  const goldSet = new Set(goldEntryIdsForQuestion(conversation, snapshotPath, qa.evidence));
  const retraceMemoryIds = (await collectCosineFilteredCandidatesForPlan(
    context,
    plan,
    goldSet,
    true,
    10,
  )).map(candidate => candidate.memoryId);
  const real = await createRealMemoryRiver(undefined, snapshotPath);
  try {
    const productionMemoryIds = memoryIdsFromResults(await real.river.enumerate(plan, 10));
    const matched = sameStringSet(retraceMemoryIds, productionMemoryIds);
    if (!matched) {
      throw new Error(
        `${conversation.sampleId} q${questionIndex}: parity check failed for cosine-filter baseline; ` +
        `retraced=${JSON.stringify(retraceMemoryIds)} production=${JSON.stringify(productionMemoryIds)}`,
      );
    }
    return {
      sampleId: conversation.sampleId,
      questionIndex,
      matched,
      retraceMemoryIds,
      productionMemoryIds,
    };
  } finally {
    await real.cleanup();
  }
}

async function relationProbeQuestion(
  context: TraceContext,
  conversation: LocomoConversation,
  snapshotPath: string,
  questionIndex: number,
  qa: LocomoConversation['qa'][number],
  includeAnnAliases: boolean,
): Promise<RelationProbeQuestion> {
  const goldEntryIds = goldEntryIdsForQuestion(conversation, snapshotPath, qa.evidence);
  const goldSet = new Set(goldEntryIds);
  const planResult = buildEnumerationPlan(qa.question, conversation);
  if (planResult.plannerSkipped || !planResult.plan) {
    return {
      sampleId: conversation.sampleId,
      questionIndex,
      plannerSkipped: true,
      goldEntryIds,
      oracleRelations: [],
      eligible: [],
      kept: [],
      returnedAt10: [],
      returnedAt50: [],
    };
  }

  const plan = relationProbePlan(planResult.plan);
  const eligible = await collectProjectedCandidatesForPlan(context, plan, goldSet, includeAnnAliases, () => true);
  const oracleRelations = [...new Set(eligible
    .flatMap(candidate => candidate.gold ? candidate.triples.map(triple => triple.triple.relation) : []))]
    .sort();
  const oracleRelationSet = new Set(oracleRelations);
  const kept = await collectProjectedCandidatesForPlan(
    context,
    plan,
    goldSet,
    includeAnnAliases,
    triple => oracleRelationSet.has(triple.triple.relation),
  );

  return {
    sampleId: conversation.sampleId,
    questionIndex,
    plannerSkipped: false,
    goldEntryIds,
    oracleRelations,
    eligible,
    kept,
    returnedAt10: kept.slice(0, 10).map((candidate, index) => ({ ...candidate, rank: index + 1 })),
    returnedAt50: kept.slice(0, 50).map((candidate, index) => ({ ...candidate, rank: index + 1 })),
  };
}

function buildRelationContingency(questions: RelationProbeQuestion[]): RelationContingencyRow[] {
  const byRelation = new Map<string, {
    goldMemories: number;
    noiseMemories: number;
    questions: Set<string>;
  }>();

  for (const question of questions.filter(item => !item.plannerSkipped)) {
    const questionKey = `${question.sampleId}\0${question.questionIndex}`;
    const relationMemorySeen = new Set<string>();
    for (const candidate of question.eligible) {
      for (const relation of new Set(candidate.triples.map(triple => triple.triple.relation))) {
        const key = `${relation}\0${candidate.memoryId}`;
        if (relationMemorySeen.has(key)) continue;
        relationMemorySeen.add(key);
        const row = byRelation.get(relation) ?? {
          goldMemories: 0,
          noiseMemories: 0,
          questions: new Set<string>(),
        };
        if (candidate.gold) row.goldMemories++;
        else row.noiseMemories++;
        row.questions.add(questionKey);
        byRelation.set(relation, row);
      }
    }
  }

  return [...byRelation.entries()]
    .map(([relation, row]) => ({
      relation,
      goldMemories: row.goldMemories,
      noiseMemories: row.noiseMemories,
      precision: row.goldMemories + row.noiseMemories > 0
        ? row.goldMemories / (row.goldMemories + row.noiseMemories)
        : 0,
      questionsUsingIt: row.questions.size,
    }))
    .sort((left, right) =>
      right.goldMemories - left.goldMemories
      || right.precision - left.precision
      || left.relation.localeCompare(right.relation)
    );
}

function summarizeRelationOracle(questions: RelationProbeQuestion[]): RelationOracleMetrics {
  const scored = questions.filter(question => !question.plannerSkipped && question.goldEntryIds.length > 0);
  const recallAt10 = scored.map(question =>
    coveredGoldEntryIdsFromCandidates(question.returnedAt10, new Set(question.goldEntryIds)).length
    / question.goldEntryIds.length
  );
  const recallAt50 = scored.map(question =>
    coveredGoldEntryIdsFromCandidates(question.returnedAt50, new Set(question.goldEntryIds)).length
    / question.goldEntryIds.length
  );
  const noiseAt10Values = scored.map(question => noiseFractionAtK(question.returnedAt10, 10));
  const relationsPerQuestion = scored.map(question => question.oracleRelations.length);
  const survivorRatios = scored.map(question => {
    const gold = question.kept.filter(candidate => candidate.gold).length;
    const noise = question.kept.filter(candidate => !candidate.gold).length;
    return gold > 0 ? noise / gold : (noise > 0 ? Number.POSITIVE_INFINITY : 0);
  }).filter(Number.isFinite);

  return {
    siblingRecallAt10: mean(recallAt10),
    siblingRecallAt50: mean(recallAt50),
    noiseAt10: mean(noiseAt10Values),
    oracleRelationsPerQuestionMean: mean(relationsPerQuestion),
    goldProjMemKept: scored.flatMap(question => question.kept).filter(candidate => candidate.gold).length,
    goldProjMemEligible: scored.flatMap(question => question.eligible).filter(candidate => candidate.gold).length,
    noiseProjMemKept: scored.flatMap(question => question.kept).filter(candidate => !candidate.gold).length,
    noiseProjMemEligible: scored.flatMap(question => question.eligible).filter(candidate => !candidate.gold).length,
    survivorNoiseGoldRatioMean: mean(survivorRatios),
    survivorNoiseGoldRatioP50: quantile(survivorRatios, 0.50) ?? 0,
  };
}

async function relationProbeConversation(
  conversation: LocomoConversation,
  snapshotPath: string,
  category: number,
): Promise<{
  fullFanout: RelationProbeQuestion[];
  exactOnly: RelationProbeQuestion[];
  parityCheck: RelationProbeResult['parityCheck'];
}> {
  const context: TraceContext = {
    table: await openGraphTriplesTable(snapshotPath),
    embedder: createRealEmbedder(),
    memoriesById: await loadMemories(snapshotPath),
    relationThreshold: DEFAULT_RELATION_THRESHOLD,
  };
  const targets = conversation.qa
    .map((qa, questionIndex) => ({ qa, questionIndex }))
    .filter(({ qa }) => qa.category === category);

  const parityTarget = targets.find(({ qa }) => {
    const planResult = buildEnumerationPlan(qa.question, conversation);
    return !planResult.plannerSkipped && !!planResult.plan;
  });
  const parityCheck = parityTarget
    ? await parityCheckQuestion(conversation, snapshotPath, parityTarget.qa, parityTarget.questionIndex)
    : null;

  const fullFanout: RelationProbeQuestion[] = [];
  const exactOnly: RelationProbeQuestion[] = [];
  for (const { qa, questionIndex } of targets) {
    fullFanout.push(await relationProbeQuestion(
      context,
      conversation,
      snapshotPath,
      questionIndex,
      qa,
      true,
    ));
    exactOnly.push(await relationProbeQuestion(
      context,
      conversation,
      snapshotPath,
      questionIndex,
      qa,
      false,
    ));
  }
  return { fullFanout, exactOnly, parityCheck };
}

function buildRelationProbeAblation(
  label: RelationProbeAblationResult['label'],
  questions: RelationProbeQuestion[],
): RelationProbeAblationResult {
  return {
    label,
    contingency: buildRelationContingency(questions),
    oracle: summarizeRelationOracle(questions),
  };
}

export async function runLocomoRelationProbe(options: AuditOptions): Promise<RelationProbeResult> {
  if (!options.snapshotDir) throw new Error('--snapshot-dir is required');

  const conversations = loadLocomo()
    .filter(conversation => !options.conversation || conversation.sampleId === options.conversation);
  if (conversations.length === 0) {
    throw new Error(`no LoCoMo conversations matched ${options.conversation ?? '(all)'}`);
  }

  const fullFanout: RelationProbeQuestion[] = [];
  const exactOnly: RelationProbeQuestion[] = [];
  const warnings: string[] = [];
  let parityCheck: RelationProbeResult['parityCheck'] = null;
  let scoredConversations = 0;

  for (const conversation of conversations) {
    const snapshotPath = findSnapshotPath(options.snapshotDir, conversation);
    if (!snapshotPath) {
      warnings.push(`${conversation.sampleId}: no restored snapshot found in ${options.snapshotDir}`);
      continue;
    }
    scoredConversations++;
    const result = await relationProbeConversation(conversation, snapshotPath, options.category);
    fullFanout.push(...result.fullFanout);
    exactOnly.push(...result.exactOnly);
    parityCheck ??= result.parityCheck;
  }

  const scoredQuestions = fullFanout.filter(question => !question.plannerSkipped).length;
  return {
    metricLabel: 'LoCoMo Relation Discrimination Probe',
    conversations: scoredConversations,
    category: options.category,
    questions: fullFanout.length,
    scoredQuestions,
    ablations: [
      buildRelationProbeAblation('full-fanout', fullFanout),
      buildRelationProbeAblation('exact-only', exactOnly),
    ],
    parityCheck,
    warnings,
  };
}

async function auditConversation(
  conversation: LocomoConversation,
  snapshotPath: string,
  category: number,
  k: number,
): Promise<QuestionAudit[]> {
  const context: TraceContext = {
    table: await openGraphTriplesTable(snapshotPath),
    embedder: createRealEmbedder(),
    memoriesById: await loadMemories(snapshotPath),
    relationThreshold: DEFAULT_RELATION_THRESHOLD,
  };
  const targets = conversation.qa
    .map((qa, questionIndex) => ({ qa, questionIndex }))
    .filter(({ qa }) => qa.category === category);

  const questions: QuestionAudit[] = [];
  for (const { qa, questionIndex } of targets) {
    questions.push(await traceQuestion(context, conversation, snapshotPath, questionIndex, qa, k));
  }
  return questions;
}

export async function runLocomoEnumNoiseAudit(options: AuditOptions): Promise<AuditResult> {
  if (!options.snapshotDir) throw new Error('--snapshot-dir is required');

  const conversations = loadLocomo()
    .filter(conversation => !options.conversation || conversation.sampleId === options.conversation);
  if (conversations.length === 0) {
    throw new Error(`no LoCoMo conversations matched ${options.conversation ?? '(all)'}`);
  }

  const questionAudits: QuestionAudit[] = [];
  const warnings: string[] = [];
  let scoredConversations = 0;
  for (const conversation of conversations) {
    const snapshotPath = findSnapshotPath(options.snapshotDir, conversation);
    if (!snapshotPath) {
      warnings.push(`${conversation.sampleId}: no restored snapshot found in ${options.snapshotDir}`);
      continue;
    }
    scoredConversations++;
    questionAudits.push(...await auditConversation(conversation, snapshotPath, options.category, options.k));
  }

  const scoredQuestions = questionAudits.filter(question => !question.plannerSkipped).length;
  const candidates = questionAudits.flatMap(question => question.returned);
  const projectedTriples = candidates.flatMap(candidate => candidate.triples);
  const aliasTriples = projectedTriples.filter(triple => triple.provenance === 'ann-alias');
  const relationTriples = projectedTriples.filter(triple => triple.relationCosine !== null);
  const aliasFanout = questionAudits.flatMap(question => question.aliasFanout);

  return {
    metricLabel: `LoCoMo Enum Noise Audit @${options.k}`,
    conversations: scoredConversations,
    category: options.category,
    k: options.k,
    questions: questionAudits.length,
    scoredQuestions,
    provenanceSplit: provenanceSplit(candidates),
    annDistance: {
      gold: quantileSummary(aliasTriples
        .filter(triple => triple.gold && triple.annDistance !== null)
        .map(triple => triple.annDistance as number)),
      noise: quantileSummary(aliasTriples
        .filter(triple => !triple.gold && triple.annDistance !== null)
        .map(triple => triple.annDistance as number)),
    },
    relationCosine: {
      gold: quantileSummary(relationTriples
        .filter(triple => triple.gold)
        .map(triple => triple.relationCosine as number)),
      noise: quantileSummary(relationTriples
        .filter(triple => !triple.gold)
        .map(triple => triple.relationCosine as number)),
    },
    aliasFanout: summarizeAliasFanout(aliasFanout),
    counterfactualGateCurves: buildCounterfactualCurves(questionAudits),
    questionAudits,
    warnings,
  };
}

function renderQuantiles(label: string, summary: QuantileSummary): string {
  return `| ${label} | ${summary.count} | ${formatNumber(summary.min)} | ${formatNumber(summary.p10)} | ` +
    `${formatNumber(summary.p50)} | ${formatNumber(summary.p90)} | ${formatNumber(summary.max)} |`;
}

export function renderLocomoEnumNoiseAudit(result: AuditResult): string {
  const split = result.provenanceSplit;
  const lines = [
    '# LoCoMo Enumeration Noise Audit',
    '',
    `${result.metricLabel}: ${result.scoredQuestions}/${result.questions} scored cat${result.category} questions`,
    `Conversations: ${result.conversations}`,
    '',
    '## Noise vs Gold Split by Provenance',
    '| Class | Total | Exact-anchor | ANN-alias | Mixed | Exact % | ANN % | Mixed % |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| Gold | ${split.gold.total} | ${split.gold.exactAnchor} | ${split.gold.annAlias} | ${split.gold.mixed} | ${pct(split.gold.exactAnchorFraction)} | ${pct(split.gold.annAliasFraction)} | ${pct(split.gold.mixedFraction)} |`,
    `| Noise | ${split.noise.total} | ${split.noise.exactAnchor} | ${split.noise.annAlias} | ${split.noise.mixed} | ${pct(split.noise.exactAnchorFraction)} | ${pct(split.noise.annAliasFraction)} | ${pct(split.noise.mixedFraction)} |`,
    '',
    '## ANN-distance Quantiles',
    '| Class | Count | Min | p10 | p50 | p90 | Max |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    renderQuantiles('Gold alias triples', result.annDistance.gold),
    renderQuantiles('Noise alias triples', result.annDistance.noise),
    '',
    '## Relation-cosine Quantiles',
    '| Class | Count | Min | p10 | p50 | p90 | Max |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    renderQuantiles('Gold triples', result.relationCosine.gold),
    renderQuantiles('Noise triples', result.relationCosine.noise),
    '',
    '## Per-alias Fanout + Gold Yield',
    '| Aliases | Mean triples | p95 triples | Max triples | Aliases with gold | Gold-yield/alias |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${result.aliasFanout.aliases} | ${result.aliasFanout.meanTriplesPulled.toFixed(2)} | ` +
      `${result.aliasFanout.p95TriplesPulled} | ${result.aliasFanout.maxTriplesPulled} | ` +
      `${result.aliasFanout.aliasesWithAnyGold} | ${pct(result.aliasFanout.goldYieldPerAlias)} |`,
    '',
    '## Counterfactual Gate Curves',
    '| Gate | Setting | Gold kept | Noise removed |',
    '| --- | --- | ---: | ---: |',
    ...result.counterfactualGateCurves.map(point =>
      `| ${point.gate} | ${point.setting} | ${pct(point.goldKeptFraction)} (${point.goldKept}/${point.goldBaseline}) | ` +
      `${pct(point.noiseRemovedFraction)} (${point.noiseRemoved}/${point.noiseBaseline}) |`,
    ),
  ];
  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:', ...result.warnings.map(warning => `- ${warning}`));
  }
  return lines.join('\n');
}

function renderRelationRows(rows: RelationContingencyRow[]): string[] {
  return rows.slice(0, 25).map(row =>
    `| ${row.relation} | ${row.goldMemories} | ${row.noiseMemories} | ` +
    `${pct(row.precision)} | ${row.questionsUsingIt} |`
  );
}

function renderOracleMetrics(metrics: RelationOracleMetrics): string[] {
  const discount = metrics.survivorNoiseGoldRatioMean < 0.25 || metrics.survivorNoiseGoldRatioP50 < 0.25
    ? [
        '',
        'Discount: survivor noise:gold is far below 1, so this ceiling may be mostly trivial gold isolation.',
      ]
    : [];
  return [
    `Oracle SiblingRecall@10: ${pct(metrics.siblingRecallAt10)}`,
    `Oracle SiblingRecall@50: ${pct(metrics.siblingRecallAt50)}`,
    `Oracle Noise@10: ${pct(metrics.noiseAt10)}`,
    `oracleRelationsPerQuestion mean: ${metrics.oracleRelationsPerQuestionMean.toFixed(2)}`,
    `goldProjMemKept/goldProjMemEligible: ${metrics.goldProjMemKept}/${metrics.goldProjMemEligible}`,
    `noiseProjMemKept/noiseProjMemEligible: ${metrics.noiseProjMemKept}/${metrics.noiseProjMemEligible}`,
    `survivor noise:gold ratio before top-k: mean=${metrics.survivorNoiseGoldRatioMean.toFixed(2)} ` +
      `p50=${metrics.survivorNoiseGoldRatioP50.toFixed(2)}`,
    ...discount,
  ];
}

export function renderLocomoRelationProbe(result: RelationProbeResult): string {
  const lines = [
    '# LoCoMo Relation Discrimination Probe',
    '',
    `${result.metricLabel}: ${result.scoredQuestions}/${result.questions} scored cat${result.category} questions`,
    `Conversations: ${result.conversations}`,
  ];
  if (result.parityCheck) {
    lines.push(
      '',
      `Parity check: matched real.river.enumerate(plan, 10) for ` +
        `${result.parityCheck.sampleId} q${result.parityCheck.questionIndex}`,
    );
  }

  for (const ablation of result.ablations) {
    lines.push(
      '',
      `## ${ablation.label}`,
      '',
      '### RELATION CONTINGENCY TABLE',
      '| Relation | Gold memories | Noise memories | Precision | # questions using it |',
      '| --- | ---: | ---: | ---: | ---: |',
      ...renderRelationRows(ablation.contingency),
      '',
      '### gold-MEMORY relation oracle (not answer-bearing-triple oracle)',
      ...renderOracleMetrics(ablation.oracle),
    );
  }

  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:', ...result.warnings.map(warning => `- ${warning}`));
  }
  return lines.join('\n');
}

export async function runCli(input: string[]): Promise<number> {
  try {
    const options = parseArgs(input);
    const result = options.relationTable
      ? await runLocomoRelationProbe(options)
      : await runLocomoEnumNoiseAudit(options);
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : (options.relationTable
            ? renderLocomoRelationProbe(result as RelationProbeResult)
            : renderLocomoEnumNoiseAudit(result as AuditResult)),
    );
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`locomo-enum-noise-audit fatal:\n${detail}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runCli(process.argv.slice(2));
}
