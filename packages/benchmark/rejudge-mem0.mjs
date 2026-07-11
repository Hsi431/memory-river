// Offline re-judge of cached LoCoMo answers under mem0's LLM-as-judge rubric.
//
// Purpose: produce a "mem0口徑" accuracy alongside our strict number from ONE benchmark
// run, WITHOUT re-running the agent. We reuse the agent answers already in the answer
// cache and only swap the JUDGE (prompt + grading leniency). The mem0 judge prompt below
// is copied verbatim (no-evidence variant) from:
//   mem0ai/memory-benchmarks  benchmarks/locomo/prompts.py  (_JUDGE_TEMPLATE, get_judge_prompt)
//
// Read-only: no engine, no LanceDB, no dist rebuild — safe to run while/after a benchmark.
//
// Inputs:
//   MR_ANSWER_CACHE     answer cache jsonl   (default /tmp/locomo_full_v2_answers.jsonl)
//   REJUDGE_OUT         summary json out     (default /tmp/locomo_rejudge_mem0.json)
//   REJUDGE_CACHE       per-question rejudge cache jsonl (default <OUT>.jsonl) — resumable
//   REJUDGE_CONCURRENCY parallel judge calls (default 6)
//   REJUDGE_LIMIT       cap questions judged (debug; default all)
// Judge model: GEMINI_JUDGE_MODEL (default gemini-2.5-flash), key from openclaw.json google.

import * as fs from 'node:fs';
import { loadLocomo } from './dist/harness/locomo.js';
import { geminiApiKey } from './dist/harness/provider-keys.js';

// Local Gemini judge call. We do NOT reuse createGeminiJudge() because its maxOutputTokens
// is hardcoded to 256, and gemini-2.5-flash (a thinking model) spends that budget on thinking
// tokens — truncating mem0's JSON output before the "label" field. Bigger budget here.
const JUDGE_MODEL = process.env.GEMINI_JUDGE_MODEL ?? 'gemini-2.5-flash';
const judgeStats = { calls: 0 };
async function geminiGenerate(prompt) {
  const key = geminiApiKey();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(JUDGE_MODEL)}` +
    `:generateContent?key=${encodeURIComponent(key)}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 1500 },
  });
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (res.ok) {
        const d = await res.json();
        judgeStats.calls++;
        return d.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('').trim() ?? '';
      }
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === 5) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      lastErr = err;
      if (attempt === 5) throw err;
    }
    await new Promise(r => setTimeout(r, Math.min(16000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500)));
  }
  throw lastErr instanceof Error ? lastErr : new Error('Gemini judge failed after retries');
}

const CACHE = process.env.MR_ANSWER_CACHE ?? '/tmp/locomo_full_v2_answers.jsonl';
const OUT = process.env.REJUDGE_OUT ?? '/tmp/locomo_rejudge_mem0.json';
const REJUDGE_CACHE = process.env.REJUDGE_CACHE ?? OUT + '.jsonl';
const CONCURRENCY = Number(process.env.REJUDGE_CONCURRENCY ?? 6);
const LIMIT = process.env.REJUDGE_LIMIT ? Number(process.env.REJUDGE_LIMIT) : Infinity;

// mem0 excludes category 5 (adversarial) from scoring; categories 1-4 are J-scored.
const SCORED_CATEGORIES = [1, 2, 3, 4];

// ── mem0 no-evidence judge prompt (verbatim from prompts.py) ──────────────────
const MEM0_SYSTEM =
  'You are evaluating conversational AI memory recall. Return JSON only with the format requested.';

const MEM0_TEMPLATE = `Label the generated answer as CORRECT or WRONG.

## Rules

1. **PARTIAL CREDIT**: If the generated answer includes AT LEAST ONE correct item from the gold answer's list, mark CORRECT. Getting 1 out of 2, 2 out of 4, etc. is always acceptable. Only mark WRONG if NONE of the gold answer items appear.

2. **PARAPHRASES COUNT**: Same concept in different words is CORRECT. "Chocolate raspberry tart" = "chocolate cake with raspberries". "Shelter meal service" = "volunteering at a homeless shelter". Emotions and sentiments in the same positive/negative family count as paraphrases: "proud" = "fulfilled" = "accomplished"; "huge success" = "relieved" = "thrilled" (all express positive achievement). Judge semantic meaning, not exact wording.

3. **EXTRA DETAIL IS FINE**: A longer answer that includes the gold answer's key facts plus additional information is CORRECT. Never penalize for being more detailed or specific. If the generated answer adds extra descriptive details beyond the gold answer while still referencing the same core entity or concept, mark CORRECT.

4. **DATE TOLERANCE**: Dates within 14 days of each other are CORRECT. Durations within 50% are CORRECT (e.g., "5 months" matches "six months"; "19 days" matches "two weeks"). Relative dates ("few days before November") match specific dates in the same window. A specific date (e.g., "February 2020") that is consistent with a vague reference (e.g., "a few years ago" relative to 2023) is CORRECT. Converting "last year" to the actual year (e.g., "2022" when conversations are in 2023) is CORRECT.

5. **SEMANTIC OVERLAP**: Judge whether the generated answer addresses the same topic and captures the core idea of the gold answer. Different wording, phrasing, or level of detail should not result in WRONG if the underlying concept matches. For EMOTIONS and FEELINGS questions, answers expressing sentiments in the same valence (positive/negative) about the same event are CORRECT — do not require the exact same emotion word.

6. **SAME REFERENT**: If the generated answer mentions or references the same named entity, character, person, or concept as the gold answer, mark CORRECT — even if the generated answer provides a different physical description or includes additional details. The key question is: does the generated answer identify the same core entity? If yes, it is CORRECT.

7. **FOCUS ON KNOWLEDGE, NOT WORDING**: The goal is to assess whether the system recalled the right fact. Minor differences in specificity, phrasing, or scope should not result in WRONG. Only mark WRONG when the generated answer demonstrates a genuinely different or incorrect understanding.

## ONLY mark WRONG if:
- The generated answer contains ZERO correct items from the gold answer
- The answer addresses a completely different topic

## Question
Question: {question}
Gold answer: {answer}
Generated answer: {response}

Return JSON with "reasoning" (one sentence) and "label" (CORRECT or WRONG). Do NOT include both labels.`;

function buildPrompt(question, answer, response) {
  return (
    MEM0_SYSTEM +
    '\n\n' +
    MEM0_TEMPLATE.replace('{question}', question)
      .replace('{answer}', answer)
      .replace('{response}', response)
  );
}

// mem0 preprocess_answer: category 3 (open-domain) uses only the part before first ';'.
function preprocessGold(category, answer) {
  const s = String(answer ?? '');
  if (category === 3 && s.includes(';')) return s.split(';')[0].trim();
  return s;
}

function parseLabel(raw) {
  const m = raw.match(/"label"\s*:\s*"?(CORRECT|WRONG)"?/i);
  if (m) return m[1].toUpperCase();
  const up = raw.toUpperCase();
  const hasC = /\bCORRECT\b/.test(up);
  const hasW = /\bWRONG\b/.test(up);
  if (hasC && !hasW) return 'CORRECT';
  if (hasW && !hasC) return 'WRONG';
  return null; // ambiguous → parse failure
}

// ── Build dataset lookup: question text → { answer, category }, flagging collisions ──
function buildGoldLookup() {
  const byQuestion = new Map();
  for (const conv of loadLocomo()) {
    for (const qa of conv.qa) {
      const key = qa.question;
      const val = { answer: qa.answer, category: Number(qa.category) };
      const prev = byQuestion.get(key);
      if (prev === undefined) {
        byQuestion.set(key, val);
      } else if (prev !== 'AMBIGUOUS') {
        if (String(prev.answer) !== String(val.answer) || prev.category !== val.category) {
          byQuestion.set(key, 'AMBIGUOUS');
        }
      }
    }
  }
  return byQuestion;
}

// ── Load answer cache: key → { question, candidate, strict } (last write wins) ──
function loadAnswerCache() {
  const entries = new Map();
  const text = fs.readFileSync(CACHE, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e?.key) continue;
    entries.set(e.key, {
      question: e.question,
      candidate: e.result?.answer ?? '',
      strict: !!e.grade?.correct,
    });
  }
  return entries;
}

// ── Resumable rejudge cache: key → label ──
function loadRejudgeCache() {
  const m = new Map();
  if (!fs.existsSync(REJUDGE_CACHE)) return m;
  for (const line of fs.readFileSync(REJUDGE_CACHE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.key && e.label) m.set(e.key, e.label);
    } catch {
      /* skip */
    }
  }
  return m;
}

async function pool(items, n, worker) {
  let i = 0;
  let done = 0;
  const total = items.length;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
      done++;
      if (done % 50 === 0 || done === total) {
        console.log(`[rejudge] ${done}/${total}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

function pct(c, t) {
  return t > 0 ? c / t : 0;
}

async function main() {
  if (!geminiApiKey()) {
    console.error('[rejudge] no Gemini key (GEMINI_API_KEY or openclaw.json google.apiKey). Abort.');
    process.exit(1);
  }
  const gold = buildGoldLookup();
  const answers = loadAnswerCache();
  const rejudged = loadRejudgeCache();
  const judge = { model: JUDGE_MODEL, generate: geminiGenerate };

  // Join answers ↔ gold; keep only scored categories (1-4) for the mem0口徑.
  const work = [];
  let unmatched = 0;
  let ambiguous = 0;
  const strictByCat = new Map(); // cat → {correct, total}  (our strict, from cache grade)
  for (const [key, a] of answers) {
    const g = gold.get(a.question);
    if (g === undefined) {
      unmatched++;
      continue;
    }
    if (g === 'AMBIGUOUS') {
      ambiguous++;
      continue;
    }
    if (!SCORED_CATEGORIES.includes(g.category)) continue;
    const sc = strictByCat.get(g.category) ?? { correct: 0, total: 0 };
    sc.total++;
    if (a.strict) sc.correct++;
    strictByCat.set(g.category, sc);
    work.push({ key, category: g.category, question: a.question, gold: preprocessGold(g.category, g.answer), candidate: a.candidate });
  }

  const todo = work.filter(w => !rejudged.has(w.key)).slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(
    `[rejudge] answers=${answers.size} matched(cat1-4)=${work.length} unmatched=${unmatched} ambiguous=${ambiguous} ` +
      `already=${work.length - todo.length} todo=${todo.length} judge=${judge.model}`,
  );

  let judgeErrors = 0;
  let parseFails = 0;
  const out = fs.createWriteStream(REJUDGE_CACHE, { flags: 'a' });
  await pool(todo, CONCURRENCY, async w => {
    let label;
    try {
      const raw = await judge.generate(buildPrompt(w.question, w.gold, w.candidate));
      label = parseLabel(raw);
      if (label === null) {
        parseFails++;
        label = 'WRONG'; // parse failure counts as wrong (conservative), but tracked
      }
    } catch (err) {
      judgeErrors++;
      console.error(`[rejudge] judge error key=${w.key}: ${err?.message ?? err}`);
      return; // leave un-cached so a re-run retries it
    }
    rejudged.set(w.key, label);
    out.write(JSON.stringify({ key: w.key, category: w.category, label }) + '\n');
  });
  out.end();

  // ── Aggregate ──
  const memCat = new Map(); // cat → {correct, total}
  for (const w of work) {
    const label = rejudged.get(w.key);
    if (!label) continue; // judge error, ungraded
    const m = memCat.get(w.category) ?? { correct: 0, total: 0 };
    m.total++;
    if (label === 'CORRECT') m.correct++;
    memCat.set(w.category, m);
  }

  const sum = (map) => {
    let c = 0, t = 0;
    for (const v of map.values()) { c += v.correct; t += v.total; }
    return { correct: c, total: t, acc: pct(c, t) };
  };
  const memOverall = sum(memCat);
  const strictOverall = sum(strictByCat);

  const report = {
    generatedAt: new Date().toISOString(),
    answerCache: CACHE,
    judgeModel: judge.model,
    rubric: 'mem0 memory-benchmarks locomo/prompts.py (no-evidence), cat1-4, cat5 excluded',
    counts: { answersInCache: answers.size, matchedCat1to4: work.length, unmatched, ambiguous, judgeErrors, parseFails },
    mem0Judge: {
      overall: memOverall.acc,
      byCategory: Object.fromEntries(SCORED_CATEGORIES.map(c => [c, (memCat.get(c)?.correct ?? 0) / Math.max(1, memCat.get(c)?.total ?? 0)])),
      raw: Object.fromEntries([...memCat].map(([c, v]) => [c, v])),
    },
    strictJudge: {
      overall: strictOverall.acc,
      byCategory: Object.fromEntries(SCORED_CATEGORIES.map(c => [c, (strictByCat.get(c)?.correct ?? 0) / Math.max(1, strictByCat.get(c)?.total ?? 0)])),
      raw: Object.fromEntries([...strictByCat].map(([c, v]) => [c, v])),
      note: 'from cached grade.correct (our Gemini strict-prompt judge / cat5 abstention); cat1-4 only here',
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  // ── Console summary ──
  const f = (x) => (x * 100).toFixed(1) + '%';
  console.log('\n===== RE-JUDGE: mem0口徑 vs strict (cat1-4) =====');
  console.log(`judge=${judge.model}  matched=${work.length}  unmatched=${unmatched}  ambiguous=${ambiguous}  judgeErr=${judgeErrors}  parseFail=${parseFails}`);
  console.log('cat |   strict |    mem0  | delta');
  for (const c of SCORED_CATEGORIES) {
    const s = (strictByCat.get(c)?.correct ?? 0) / Math.max(1, strictByCat.get(c)?.total ?? 0);
    const m = (memCat.get(c)?.correct ?? 0) / Math.max(1, memCat.get(c)?.total ?? 0);
    console.log(` ${c}  |  ${f(s).padStart(6)} |  ${f(m).padStart(6)} | +${((m - s) * 100).toFixed(1)}pp`);
  }
  console.log(`all |  ${f(strictOverall.acc).padStart(6)} |  ${f(memOverall.acc).padStart(6)} | +${((memOverall.acc - strictOverall.acc) * 100).toFixed(1)}pp`);
  console.log(`\nwrote ${OUT}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
