import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import { AutoTokenizer, env } from '@xenova/transformers';
import * as ortNamespace from 'onnxruntime-node';

export interface RerankerModelSpec {
  role: 'primary' | 'fallback';
  modelId: string;
  revision: string;
  onnxCandidates: string[];
}

// v2-m3 weights as an ONNX export (BAAI/bge-reranker-v2-m3 ships safetensors only, no ONNX).
// onnx-community is the community ONNX export of the same XLM-R-large reranker weights.
export const PRIMARY_RERANKER_MODEL: RerankerModelSpec = {
  role: 'primary',
  modelId: 'onnx-community/bge-reranker-v2-m3-ONNX',
  revision: '6f5ff65298512715a1e669753bc754d2bc8f367b',
  onnxCandidates: [
    'onnx/model_quantized.onnx',
    'onnx/model_int8.onnx',
    'model_quantized.onnx',
    'model_int8.onnx',
  ],
};

export const FALLBACK_RERANKER_MODEL: RerankerModelSpec = {
  role: 'fallback',
  modelId: 'Xenova/bge-reranker-base',
  revision: '280bcc2',
  onnxCandidates: [
    'onnx/model_quantized.onnx',
    'onnx/model_int8.onnx',
    'model_quantized.onnx',
    'model_int8.onnx',
  ],
};

// Small multilingual (incl. Chinese, via mMARCO) XLM-R cross-encoder reranker.
// Official repo ships ONNX with CPU-quantized variants; quint8_avx2 suits Zen3.
// Candidate for the production CRAG gate (~100M, scores only the injection shortlist).
export const MMARCO_MMINILM_RERANKER_MODEL: RerankerModelSpec = {
  role: 'primary',
  modelId: 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1',
  revision: 'main',
  onnxCandidates: [
    'onnx/model_quint8_avx2.onnx',
    'onnx/model_quantized.onnx',
    'onnx/model.onnx',
  ],
};

export interface CrossEncoderRerankerOptions {
  modelDir?: string;
  cacheDir?: string;
  threads?: number;
  batchSize?: number;
  maxLength?: number;
  passageTokenLimit?: number;
  allowFallback?: boolean;
  /** Override the model to load (tried before primary/fallback). */
  spec?: RerankerModelSpec;
}

export interface CrossEncoderRerankerInfo {
  modelId: string;
  revision: string;
  role: 'primary' | 'fallback';
  modelDir: string;
  onnxPath: string;
  fallbackReason?: string;
  loadMs: number;
  threads: number;
  batchSize: number;
  maxLength: number;
  passageTokenLimit: number;
}

export interface RerankPair {
  query: string;
  passage: string;
}

export interface ScoreBatchTiming {
  pairs: number;
  batches: number;
  timedMs: number;
  perPairMs: number;
}

type OrtModule = typeof ortNamespace & {
  default?: typeof ortNamespace;
};

type Tokenizer = {
  encode(input: string): number[];
};

interface ResolvedModel {
  spec: RerankerModelSpec;
  modelDir: string;
  onnxPath: string;
  fallbackReason?: string;
}

const ort = ((ortNamespace as OrtModule).default ?? ortNamespace) as typeof ortNamespace;

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function defaultCacheDir(): string {
  return process.env.TRANSFORMERS_CACHE
    ?? process.env.HF_HOME
    ?? path.join(os.homedir(), '.cache', 'huggingface');
}

function modelDirCandidates(spec: RerankerModelSpec, options: CrossEncoderRerankerOptions): string[] {
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const candidates = [
    ...(options.modelDir ? [options.modelDir] : []),
    path.join(cacheDir, spec.modelId),
    path.join(cacheDir, ...spec.modelId.split('/')),
  ];
  return [...new Set(candidates)];
}

function findOnnx(modelDir: string, candidates: string[]): string | null {
  for (const relative of candidates) {
    const candidate = path.join(modelDir, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveSpec(
  spec: RerankerModelSpec,
  options: CrossEncoderRerankerOptions,
): ResolvedModel | null {
  for (const modelDir of modelDirCandidates(spec, options)) {
    const onnxPath = findOnnx(modelDir, spec.onnxCandidates);
    if (onnxPath) return { spec, modelDir, onnxPath };
  }
  return null;
}

function resolveModel(options: CrossEncoderRerankerOptions): ResolvedModel {
  if (options.spec) {
    const custom = resolveSpec(options.spec, options);
    if (custom) return custom;
    throw new Error(
      `${options.spec.modelId}@${options.spec.revision} ONNX not found under ` +
      modelDirCandidates(options.spec, options).join(', '),
    );
  }

  const primary = resolveSpec(PRIMARY_RERANKER_MODEL, options);
  if (primary) return primary;

  const primaryReason =
    `${PRIMARY_RERANKER_MODEL.modelId}@${PRIMARY_RERANKER_MODEL.revision} quantized ONNX ` +
    `not found under ${modelDirCandidates(PRIMARY_RERANKER_MODEL, options).join(', ')}`;
  if (options.allowFallback === false) throw new Error(primaryReason);

  const fallback = resolveSpec(FALLBACK_RERANKER_MODEL, {
    ...options,
    modelDir: undefined,
  });
  if (!fallback) {
    throw new Error(
      `${primaryReason}; fallback ${FALLBACK_RERANKER_MODEL.modelId}@${FALLBACK_RERANKER_MODEL.revision} ` +
      `quantized ONNX also not found under ${modelDirCandidates(FALLBACK_RERANKER_MODEL, options).join(', ')}`,
    );
  }
  return { ...fallback, fallbackReason: primaryReason };
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

function makeTensor(values: number[], dims: readonly number[]): ortNamespace.Tensor {
  return new ort.Tensor(
    'int64',
    BigInt64Array.from(values.map(value => BigInt(value))),
    [...dims],
  );
}

export class CrossEncoderReranker {
  readonly info: CrossEncoderRerankerInfo;
  private constructor(
    private readonly session: ortNamespace.InferenceSession,
    private readonly tokenizer: Tokenizer,
    info: CrossEncoderRerankerInfo,
  ) {
    this.info = info;
  }

  static async load(options: CrossEncoderRerankerOptions = {}): Promise<CrossEncoderReranker> {
    const threads = positiveInteger('threads', options.threads, 4);
    const batchSize = positiveInteger('batchSize', options.batchSize, 8);
    const maxLength = positiveInteger('maxLength', options.maxLength, 512);
    const passageTokenLimit = positiveInteger('passageTokenLimit', options.passageTokenLimit, 320);
    if (passageTokenLimit > maxLength - 4) {
      throw new Error('passageTokenLimit must fit within maxLength after pair special tokens');
    }

    const started = performance.now();
    const resolved = resolveModel(options);
    env.allowRemoteModels = false;
    env.localModelPath = options.cacheDir ?? defaultCacheDir();

    const tokenizer = await AutoTokenizer.from_pretrained(resolved.spec.modelId, {
      revision: resolved.spec.revision,
    }) as Tokenizer;
    const session = await ort.InferenceSession.create(resolved.onnxPath, {
      executionProviders: ['cpu'],
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
    });
    const loadMs = performance.now() - started;
    return new CrossEncoderReranker(session, tokenizer, {
      modelId: resolved.spec.modelId,
      revision: resolved.spec.revision,
      role: resolved.spec.role,
      modelDir: resolved.modelDir,
      onnxPath: resolved.onnxPath,
      fallbackReason: resolved.fallbackReason,
      loadMs,
      threads,
      batchSize,
      maxLength,
      passageTokenLimit,
    });
  }

  async warm(): Promise<void> {
    await this.scorePairs([{ query: 'warmup query', passage: 'warmup passage' }]);
  }

  async scorePairs(pairs: RerankPair[]): Promise<{ logits: number[]; timing: ScoreBatchTiming }> {
    const started = performance.now();
    const logits: number[] = [];
    let batches = 0;
    for (let offset = 0; offset < pairs.length; offset += this.info.batchSize) {
      const batch = pairs.slice(offset, offset + this.info.batchSize);
      const outputs = await this.runBatch(batch);
      logits.push(...outputs);
      batches++;
    }
    const timedMs = performance.now() - started;
    return {
      logits,
      timing: {
        pairs: pairs.length,
        batches,
        timedMs,
        perPairMs: pairs.length > 0 ? timedMs / pairs.length : 0,
      },
    };
  }

  private async runBatch(pairs: RerankPair[]): Promise<number[]> {
    if (pairs.length === 0) return [];
    const encoded = pairs.map(pair => buildPairIds({
      tokenizer: this.tokenizer,
      query: pair.query,
      passage: pair.passage,
      maxLength: this.info.maxLength,
      passageTokenLimit: this.info.passageTokenLimit,
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
      input_ids: makeTensor(inputIds, [pairs.length, seqLength]),
      attention_mask: makeTensor(attentionMask, [pairs.length, seqLength]),
    });
    const logits = outputs.logits;
    if (!logits) throw new Error('ONNX session did not return logits');
    return Array.from(logits.data as Float32Array | Float64Array | number[]).map(Number);
  }
}
