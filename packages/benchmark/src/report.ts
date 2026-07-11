import * as fs from 'node:fs';

export interface BenchmarkResult {
  dimension: string;
  metrics: Record<string, number>;
  details?: Record<string, unknown>;
}

export interface BenchmarkReport {
  generatedAt: string;
  results: BenchmarkResult[];
  fatalError?: string;
}

export function createReport(results: BenchmarkResult[]): BenchmarkReport {
  return {
    generatedAt: new Date().toISOString(),
    results,
  };
}

export function writeJsonReport(filePath: string, report: BenchmarkReport): void {
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function renderInstrumentationSummary(report: BenchmarkReport): string {
  const locomo = report.results.find(result => result.dimension === 'locomo');
  const instrumentation = locomo?.details?.instrumentation as {
    questionsCompleted?: number;
    tokens?: {
      deepseekAgent?: { promptTokens?: number; completionTokens?: number };
      concentrationIngestion?: {
        promptTokens?: number;
        completionTokens?: number;
        byProvider?: Record<string, { promptTokens?: number; completionTokens?: number }>;
      };
      geminiJudge?: { promptTokens?: number; completionTokens?: number };
    };
    wallClockSeconds?: { total?: number; perQuestionAverage?: number };
  } | undefined;
  if (!instrumentation) return '';
  const agent = instrumentation.tokens?.deepseekAgent;
  const ingestion = instrumentation.tokens?.concentrationIngestion;
  const judge = instrumentation.tokens?.geminiJudge;
  const ingestionGemini = ingestion?.byProvider?.gemini;
  const ingestionDeepSeek = ingestion?.byProvider?.deepseek;
  return [
    'LOCOMO_METRICS',
    `questions=${instrumentation.questionsCompleted ?? 0}`,
    `deepseek_agent_in=${agent?.promptTokens ?? 0}`,
    `deepseek_agent_out=${agent?.completionTokens ?? 0}`,
    `ingestion_in=${ingestion?.promptTokens ?? 0}`,
    `ingestion_out=${ingestion?.completionTokens ?? 0}`,
    `ingestion_gemini_in=${ingestionGemini?.promptTokens ?? 0}`,
    `ingestion_gemini_out=${ingestionGemini?.completionTokens ?? 0}`,
    `ingestion_deepseek_in=${ingestionDeepSeek?.promptTokens ?? 0}`,
    `ingestion_deepseek_out=${ingestionDeepSeek?.completionTokens ?? 0}`,
    `gemini_judge_in=${judge?.promptTokens ?? 0}`,
    `gemini_judge_out=${judge?.completionTokens ?? 0}`,
    `wall_seconds=${(instrumentation.wallClockSeconds?.total ?? 0).toFixed(3)}`,
    `seconds_per_question=${(instrumentation.wallClockSeconds?.perQuestionAverage ?? 0).toFixed(3)}`,
  ].join(' ');
}

const RETRIEVAL_COLUMNS = ['recall@1', 'recall@3', 'recall@5', 'mrr', 'ndcg@5'] as const;

function renderRetrievalDetails(details: Record<string, unknown>): string[] {
  const lines: string[] = [];

  if (details.skipped) {
    lines.push('', `> retrieval skipped: ${String(details.skipped)} — ${String(details.hint ?? '')}`);
    return lines;
  }

  const matrix = details.baselineMatrix as Record<string, Record<string, number>> | undefined;
  if (matrix) {
    lines.push('', '### Retrieval baseline comparison', '');
    lines.push(`| Path | ${RETRIEVAL_COLUMNS.join(' | ')} |`);
    lines.push(`| --- | ${RETRIEVAL_COLUMNS.map(() => '---:').join(' | ')} |`);
    for (const [pathName, scores] of Object.entries(matrix)) {
      const cells = RETRIEVAL_COLUMNS.map(c => (scores[c] ?? 0).toFixed(4));
      lines.push(`| ${pathName} | ${cells.join(' | ')} |`);
    }
  }

  const judge = details.judge as { ran?: boolean; model?: string; accuracy?: Record<string, number> } | undefined;
  if (judge?.ran && judge.accuracy) {
    lines.push('', `### Answer-level judge (${judge.model})`, '');
    lines.push('| Path | answer_accuracy |', '| --- | ---: |');
    for (const [pathName, acc] of Object.entries(judge.accuracy)) {
      lines.push(`| ${pathName} | ${acc.toFixed(4)} |`);
    }
  }

  return lines;
}

function renderLocomoDetails(details: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (details.skipped) {
    lines.push('', `> locomo skipped: ${String(details.skipped)}`);
    return lines;
  }

  const categories = details.categoryAccuracy as
    Record<string, { correct: number; total: number; accuracy: number }> | undefined;
  if (categories) {
    lines.push('', '### LoCoMo accuracy by category', '');
    lines.push('| Category | Correct | Total | Accuracy |', '| --- | ---: | ---: | ---: |');
    for (const [category, score] of Object.entries(categories)) {
      lines.push(
        `| ${category} | ${score.correct} | ${score.total} | ${score.accuracy.toFixed(4)} |`,
      );
    }
  }
  return lines;
}

export function renderMarkdown(report: BenchmarkReport): string {
  const lines = [
    '# Memory River Benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '| Dimension | Metric | Value |',
    '| --- | --- | ---: |',
  ];
  for (const result of report.results) {
    for (const [metric, value] of Object.entries(result.metrics)) {
      lines.push(`| ${result.dimension} | ${metric} | ${value.toFixed(4)} |`);
    }
  }
  for (const result of report.results) {
    if (result.dimension === 'retrieval' && result.details) {
      lines.push(...renderRetrievalDetails(result.details));
    }
    if (result.dimension === 'locomo' && result.details) {
      lines.push(...renderLocomoDetails(result.details));
    }
  }
  return lines.join('\n');
}
