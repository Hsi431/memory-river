import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

export interface CrossEncoderGateCandidate {
  entry: { text: string };
  fusedScore?: number;
  finalScore?: number;
}

export interface RerankPair {
  query: string;
  passage: string;
}

export interface CrossEncoderScorer {
  scorePairs(pairs: RerankPair[]): Promise<{ logits: number[] }>;
}

export interface CrossEncoderGateOptions {
  env?: NodeJS.ProcessEnv;
  cacheDir?: string;
  modelDir?: string;
  topK?: number;
  scorer?: CrossEncoderScorer;
  logger?: Pick<Console, "warn" | "log">;
}

export interface ScoredCandidate<T extends CrossEncoderGateCandidate> {
  candidate: T;
  logit: number;
}

export interface ScoreCandidatesResult<T extends CrossEncoderGateCandidate> {
  scored: ScoredCandidate<T>[];
  timingMs: number;
}

interface RerankerModelSpec {
  modelId: string;
  revision: string;
  onnxCandidates: string[];
}

type Tokenizer = {
  encode(input: string): number[];
};

interface ResolvedModel {
  spec: RerankerModelSpec;
  modelDir: string;
  onnxPath: string;
}

const MMARCO_MMINILM_RERANKER_MODEL: RerankerModelSpec = {
  modelId: "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1",
  revision: "main",
  onnxCandidates: [
    "onnx/model_quint8_avx2.onnx",
    "onnx/model_quantized.onnx",
    "onnx/model.onnx",
  ],
};

const DEFAULT_TOP_K = 5;
const DEFAULT_ZH_LOGIT = -7.0;
const DEFAULT_EN_LOGIT = 3.47;
const DEFAULT_THREADS = 4;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_MAX_LENGTH = 512;
const DEFAULT_PASSAGE_TOKEN_LIMIT = 320;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;

let scorerPromise: Promise<CrossEncoderScorer | null> | null = null;
let warningEmitted = false;
let scorerOverride: CrossEncoderScorer | null = null;

export function isCragCrossEncoderGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Enabled by default (fix for the dead cosine gate); disable with MR_CRAG_CROSS_ENCODER=0.
  return env.MR_CRAG_CROSS_ENCODER !== "0" && env.ENABLE_CRAG_GATE !== "0";
}

export function containsCjk(text: string): boolean {
  return CJK_RE.test(text);
}

export function cragGateThresholdForText(
  query: string,
  passage: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = containsCjk(`${query}\n${passage}`)
    ? env.MR_CRAG_GATE_ZH_LOGIT
    : env.MR_CRAG_GATE_EN_LOGIT;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (Number.isFinite(parsed)) return parsed;
  return containsCjk(`${query}\n${passage}`) ? DEFAULT_ZH_LOGIT : DEFAULT_EN_LOGIT;
}

export function cragGateTopK(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.MR_CRAG_GATE_TOPK);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TOP_K;
}

function candidateScore(candidate: CrossEncoderGateCandidate): number {
  return Number(candidate.finalScore ?? candidate.fusedScore ?? 0);
}

export async function scoreCandidates<T extends CrossEncoderGateCandidate>(
  query: string,
  candidates: T[],
  options?: CrossEncoderGateOptions,
): Promise<ScoreCandidatesResult<T> | null> {
  const gateOptions = options ?? {};
  const env = gateOptions.env ?? process.env;
  if (!isCragCrossEncoderGateEnabled(env) || candidates.length === 0) return null;

  const topK = gateOptions.topK ?? cragGateTopK(env);
  const shortlist = candidates
    .map((candidate, index) => ({ candidate, index, score: candidateScore(candidate) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.min(topK, candidates.length));

  if (shortlist.length === 0) return null;

  const scorer = gateOptions.scorer ?? await getCrossEncoderScorer(gateOptions);
  if (!scorer) return null;

  const pairs = shortlist.map(({ candidate }) => ({
    query,
    passage: candidate.entry.text,
  }));
  const started = performance.now();
  const { logits } = await scorer.scorePairs(pairs);
  const timingMs = performance.now() - started;

  return {
    scored: shortlist.map((shortlisted, index) => ({
      candidate: shortlisted.candidate,
      logit: Number(logits[index]),
    })),
    timingMs,
  };
}

export async function applyCragCrossEncoderGate<T extends CrossEncoderGateCandidate>(
  query: string,
  candidates: T[],
  options: CrossEncoderGateOptions = {},
): Promise<T[]> {
  const env = options.env ?? process.env;
  const result = await scoreCandidates(query, candidates, options);
  if (result === null) return candidates;

  const rejected = new Set<T>();
  for (const { candidate, logit } of result.scored) {
    const threshold = cragGateThresholdForText(query, candidate.entry.text, env);
    if (Number.isFinite(logit) && logit < threshold) {
      rejected.add(candidate);
    }
  }

  return candidates.filter(candidate => !rejected.has(candidate));
}

async function getCrossEncoderScorer(options: CrossEncoderGateOptions): Promise<CrossEncoderScorer | null> {
  if (scorerOverride) return scorerOverride;
  if (!scorerPromise) {
    scorerPromise = loadCrossEncoderScorer(options).catch((err) => {
      const logger = options.logger ?? console;
      if (!warningEmitted) {
        warningEmitted = true;
        logger.warn("[CRAG] cross-encoder gate unavailable; passing candidates through:", err?.message ?? err);
      }
      return null;
    });
  }
  return scorerPromise;
}

function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRANSFORMERS_CACHE
    ?? env.HF_HOME
    ?? path.join(os.homedir(), ".cache", "huggingface");
}

function modelDirCandidates(spec: RerankerModelSpec, options: CrossEncoderGateOptions): string[] {
  const cacheDir = options.cacheDir ?? defaultCacheDir(options.env);
  return [...new Set([
    ...(options.modelDir ? [options.modelDir] : []),
    path.join(cacheDir, spec.modelId),
    path.join(cacheDir, ...spec.modelId.split("/")),
  ])];
}

function findOnnx(modelDir: string, candidates: string[]): string | null {
  for (const relative of candidates) {
    const candidate = path.join(modelDir, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveModel(options: CrossEncoderGateOptions): ResolvedModel {
  for (const modelDir of modelDirCandidates(MMARCO_MMINILM_RERANKER_MODEL, options)) {
    const onnxPath = findOnnx(modelDir, MMARCO_MMINILM_RERANKER_MODEL.onnxCandidates);
    if (onnxPath) return { spec: MMARCO_MMINILM_RERANKER_MODEL, modelDir, onnxPath };
  }
  throw new Error(
    `${MMARCO_MMINILM_RERANKER_MODEL.modelId} ONNX not found under ` +
    modelDirCandidates(MMARCO_MMINILM_RERANKER_MODEL, options).join(", "),
  );
}

function innerTokenIds(tokenizer: Tokenizer, text: string): number[] {
  const encoded = tokenizer.encode(text);
  if (encoded.length >= 2 && encoded[0] === 0 && encoded[encoded.length - 1] === 2) {
    return encoded.slice(1, -1);
  }
  return encoded;
}

function buildPairIds(input: {
  tokenizer: Tokenizer;
  query: string;
  passage: string;
  maxLength: number;
  passageTokenLimit: number;
}): number[] {
  const queryTokens = innerTokenIds(input.tokenizer, input.query);
  const passageTokens = innerTokenIds(input.tokenizer, input.passage);
  const maxPayload = Math.max(0, input.maxLength - 4);
  const queryBudget = Math.min(queryTokens.length, maxPayload);
  const query = queryTokens.slice(0, queryBudget);
  const remaining = Math.max(0, maxPayload - query.length);
  const passageBudget = Math.min(input.passageTokenLimit, remaining);
  const passage = passageTokens.slice(0, passageBudget);
  return [0, ...query, 2, 2, ...passage, 2];
}

function makeTensor(ort: any, values: number[], dims: readonly number[]): any {
  return new ort.Tensor(
    "int64",
    BigInt64Array.from(values.map(value => BigInt(value))),
    [...dims],
  );
}

async function loadCrossEncoderScorer(options: CrossEncoderGateOptions): Promise<CrossEncoderScorer> {
  const resolved = resolveModel(options);
  const started = performance.now();
  const [{ AutoTokenizer, env }, ortNamespace] = await Promise.all([
    import("@xenova/transformers"),
    import("onnxruntime-node"),
  ]);
  const ort = (ortNamespace as any).default ?? ortNamespace;
  (env as any).allowRemoteModels = false;
  (env as any).localModelPath = options.cacheDir ?? defaultCacheDir(options.env);
  (env as any).cacheDir = options.cacheDir ?? defaultCacheDir(options.env);

  const tokenizer = await AutoTokenizer.from_pretrained(resolved.spec.modelId, {
    revision: resolved.spec.revision,
  }) as Tokenizer;
  const session = await ort.InferenceSession.create(resolved.onnxPath, {
    executionProviders: ["cpu"],
    intraOpNumThreads: DEFAULT_THREADS,
    interOpNumThreads: 1,
    graphOptimizationLevel: "all",
  });
  const scorer = new OnnxCrossEncoderScorer(ort, session, tokenizer);
  await scorer.scorePairs([{ query: "warmup query", passage: "warmup passage" }]);
  options.logger?.log?.(
    `[CRAG] cross-encoder gate loaded ${resolved.onnxPath} in ${Math.round(performance.now() - started)}ms`,
  );
  return scorer;
}

class OnnxCrossEncoderScorer implements CrossEncoderScorer {
  constructor(
    private readonly ort: any,
    private readonly session: any,
    private readonly tokenizer: Tokenizer,
  ) {}

  async scorePairs(pairs: RerankPair[]): Promise<{ logits: number[] }> {
    const logits: number[] = [];
    for (let offset = 0; offset < pairs.length; offset += DEFAULT_BATCH_SIZE) {
      const batch = pairs.slice(offset, offset + DEFAULT_BATCH_SIZE);
      logits.push(...await this.runBatch(batch));
    }
    return { logits };
  }

  private async runBatch(pairs: RerankPair[]): Promise<number[]> {
    if (pairs.length === 0) return [];
    const encoded = pairs.map(pair => buildPairIds({
      tokenizer: this.tokenizer,
      query: pair.query,
      passage: pair.passage,
      maxLength: DEFAULT_MAX_LENGTH,
      passageTokenLimit: DEFAULT_PASSAGE_TOKEN_LIMIT,
    }));
    const seqLength = Math.max(...encoded.map(item => item.length));
    const inputIds: number[] = [];
    const attentionMask: number[] = [];
    for (const ids of encoded) {
      inputIds.push(...ids);
      attentionMask.push(...ids.map(id => id === 1 ? 0 : 1));
      for (let index = ids.length; index < seqLength; index++) {
        inputIds.push(1);
        attentionMask.push(0);
      }
    }

    const outputs = await this.session.run({
      input_ids: makeTensor(this.ort, inputIds, [pairs.length, seqLength]),
      attention_mask: makeTensor(this.ort, attentionMask, [pairs.length, seqLength]),
    });
    if (!outputs.logits) throw new Error("ONNX session did not return logits");
    return Array.from(outputs.logits.data as Float32Array | Float64Array | number[]).map(Number);
  }
}

export function __setCragCrossEncoderScorerForTests(scorer: CrossEncoderScorer | null): void {
  scorerOverride = scorer;
  scorerPromise = null;
  warningEmitted = false;
}

export function __resetCragCrossEncoderForTests(): void {
  scorerOverride = null;
  scorerPromise = null;
  warningEmitted = false;
}
