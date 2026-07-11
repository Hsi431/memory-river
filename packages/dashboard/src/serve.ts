import { createServer, type Server, type ServerResponse } from 'node:http';

import {
  getEffectivenessSummary,
  type EffectivenessOptions,
  type EffectivenessSubsystemSummary,
} from './effectiveness.js';
import { getNightSummary, type NightRun } from './night.js';
import {
  connectDb,
  openRequiredTable,
  parseMetadata,
  sqlString,
} from './shared.js';
import { getTablesSummary } from './tables.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

interface PageOptions {
  limit: number;
  offset: number;
}

interface StartedServer {
  server: Server;
  port: number;
  url: string;
}

export interface DashboardResponse {
  status: number;
  contentType: string;
  body: unknown;
}

function jsonValue(value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body, (_key, value) => jsonValue(value)));
}

function parseInteger(
  params: URLSearchParams,
  name: string,
  defaultValue: number,
  maximum?: number,
): number {
  const raw = params.get(name);
  if (raw === null || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || (maximum !== undefined && value > maximum)) {
    const range = maximum === undefined ? 'a non-negative integer' : `an integer from 0 to ${maximum}`;
    throw new Error(`${name} must be ${range}`);
  }
  return value;
}

function parsePage(params: URLSearchParams): PageOptions {
  return {
    limit: parseInteger(params, 'limit', DEFAULT_LIMIT, MAX_LIMIT),
    offset: parseInteger(params, 'offset', 0),
  };
}

function optionalParam(params: URLSearchParams, name: string): string {
  return (params.get(name) ?? '').trim();
}

function likeCondition(column: string, value: string): string {
  return `\`${column}\` LIKE ${sqlString(`%${value}%`)}`;
}

function combineConditions(conditions: string[]): string | null {
  return conditions.length > 0 ? conditions.join(' AND ') : null;
}

function mapMemory(row: Record<string, unknown>): Record<string, unknown> {
  const metadata = parseMetadata(row.metadata);
  const health = parseMetadata(metadata.health);
  const healthScore = Number(health.healthScore);
  return {
    id: String(row.id ?? ''),
    text: String(row.text ?? ''),
    category: String(row.category ?? ''),
    importance: Number(row.importance ?? 0),
    confidence: Number(row.confidence ?? 0),
    status: String(row.status ?? ''),
    slotKey: row.slotKey === null || row.slotKey === undefined ? null : String(row.slotKey),
    slotValue: row.slotValue === null || row.slotValue === undefined ? null : jsonValue(row.slotValue),
    sessionId: String(row.sessionId ?? ''),
    parentId: String(row.parentId ?? ''),
    createdAt: jsonValue(row.createdAt),
    updatedAt: jsonValue(row.updatedAt),
    healthScore: Number.isFinite(healthScore) ? healthScore : null,
  };
}

async function getMemories(dbPath: string, params: URLSearchParams): Promise<Record<string, unknown>> {
  const page = parsePage(params);
  const category = optionalParam(params, 'category');
  const status = optionalParam(params, 'status');
  const q = optionalParam(params, 'q');
  const conditions: string[] = [];
  if (category) conditions.push(`\`category\` = ${sqlString(category)}`);
  if (status) conditions.push(`\`status\` = ${sqlString(status)}`);
  if (q) conditions.push(likeCondition('text', q));
  const where = combineConditions(conditions);

  const db = await connectDb(dbPath);
  const table = await openRequiredTable(db, dbPath, 'memories');
  let query = table.query();
  if (where) query = query.where(where);
  const rows = await query.limit(page.limit).offset(page.offset).toArray() as Record<string, unknown>[];
  return {
    ...page,
    total: await table.countRows(where ?? undefined),
    items: rows.map(mapMemory),
  };
}

async function getGraph(dbPath: string, params: URLSearchParams): Promise<Record<string, unknown>> {
  const page = parsePage(params);
  const q = optionalParam(params, 'q');
  const where = q
    ? `(${likeCondition('subject', q)} OR ${likeCondition('object', q)})`
    : null;
  const db = await connectDb(dbPath);
  const table = await openRequiredTable(db, dbPath, 'graph_triples');
  let query = table.query();
  if (where) query = query.where(where);
  const rows = await query.limit(page.limit).offset(page.offset).toArray() as Record<string, unknown>[];
  return {
    ...page,
    total: await table.countRows(where ?? undefined),
    items: rows.map(row => ({
      subject: String(row.subject ?? ''),
      relation: String(row.relation ?? ''),
      object: String(row.object ?? ''),
      sourceMemoryId: String(row.sourceMemoryId ?? ''),
      createdAt: jsonValue(row.createdAt),
    })),
  };
}

async function getSlots(dbPath: string, params: URLSearchParams): Promise<Record<string, unknown>> {
  const page = parsePage(params);
  const where = '`slotKey` IS NOT NULL AND `slotKey` != \'\'';
  const db = await connectDb(dbPath);
  const table = await openRequiredTable(db, dbPath, 'memories');
  const rows = await table.query()
    .where(where)
    .limit(page.limit)
    .offset(page.offset)
    .toArray() as Record<string, unknown>[];
  return {
    ...page,
    total: await table.countRows(where),
    items: rows.map(mapMemory),
  };
}

function serializeSubsystem(summary: EffectivenessSubsystemSummary): Record<string, unknown> {
  return {
    name: summary.name,
    eventCount: summary.rows.length,
    isAttribution: summary.isAttribution,
    outcomes: Object.fromEntries(summary.outcomes),
    methods: Object.fromEntries(summary.methods),
    scores: {
      min: percentile(summary.scores, 0),
      median: percentile(summary.scores, 0.5),
      p75: percentile(summary.scores, 0.75),
      max: percentile(summary.scores, 1),
    },
    health: summary.health,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function serializeRun(run: NightRun): Record<string, unknown> {
  return {
    runId: run.runId,
    source: jsonValue(run.source),
    firstTs: run.firstTs,
    lastTs: run.lastTs,
    verdict: run.verdict,
    phases: run.rows.map(row => ({
      ts: row.ts,
      phase: row.phase,
      outcome: row.outcome ?? null,
      durationMs: row.durationMs ?? null,
      candidateCount: row.candidateCount ?? null,
      attemptedCount: row.attemptedCount ?? null,
      failedCount: row.failedCount ?? null,
    })),
  };
}

async function apiResponse(dbPath: string, url: URL): Promise<unknown> {
  if (url.pathname === '/api/tables') return { items: await getTablesSummary(dbPath) };
  if (url.pathname === '/api/effectiveness') {
    const subsystem = optionalParam(url.searchParams, 'subsystem');
    const args: EffectivenessOptions = {
      since: optionalParam(url.searchParams, 'since') || '24h',
      subsystem: subsystem ? subsystem.split(',').map(value => value.trim()).filter(Boolean) : null,
      raw: 0,
      meta: false,
      metaKeys: null,
    };
    const summary = await getEffectivenessSummary(dbPath, args);
    return {
      window: summary.window,
      totalEvents: summary.totalEvents,
      subsystems: summary.subsystems.map(serializeSubsystem),
    };
  }
  if (url.pathname === '/api/night') {
    const summary = await getNightSummary(dbPath, {
      since: optionalParam(url.searchParams, 'since') || '7d',
    });
    return {
      window: summary.window,
      totalRuns: summary.totalRuns,
      verdicts: summary.verdicts,
      runs: summary.runs.map(serializeRun),
    };
  }
  if (url.pathname === '/api/memories') return getMemories(dbPath, url.searchParams);
  if (url.pathname === '/api/graph') return getGraph(dbPath, url.searchParams);
  if (url.pathname === '/api/slots') return getSlots(dbPath, url.searchParams);
  throw Object.assign(new Error('API endpoint not found'), { statusCode: 404 });
}

const UI_HTML = String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Memory River Dashboard</title>
  <style>
    :root{
      --bg:#eef2f7; --card:#fff; --ink:#1e2630; --muted:#6b7785; --line:#e3e8ef;
      --brand:#2f6f9f; --brand-dark:#21455f; --accent:#eaf3fb;
      --ok:#1f9d55; --warn:#c98a00; --bad:#c0392b;
      color-scheme:light;
      font-family:system-ui,-apple-system,"Segoe UI","PingFang TC","Microsoft JhengHei","Noto Sans CJK TC",sans-serif;
      --th-bg:#f4f7fb; --th-ink:#3a4654; --row-even:#fafbfd; --row-hover:#eef5fb; --desc-ink:#34495e;
      color:var(--ink); background:var(--bg);
    }
    html[data-theme="dark"]{
      --bg:#0f1620; --card:#1a2330; --ink:#e4e8ee; --muted:#8b97a5; --line:#2b3848;
      --brand:#4a9fd8; --brand-dark:#16222f; --accent:#1b2a39;
      --ok:#3fc97f; --warn:#e0a93a; --bad:#e57368;
      --th-bg:#222e3c; --th-ink:#c4cedb; --row-even:#1e2835; --row-hover:#26303f; --desc-ink:#b8c4d0;
      color-scheme:dark;
    }
    *{ box-sizing:border-box; }
    body{ margin:0; }
    header{ display:flex; align-items:center; justify-content:space-between; gap:16px;
      padding:16px 28px; background:linear-gradient(135deg,var(--brand-dark),var(--brand));
      color:#fff; box-shadow:0 2px 10px rgba(0,0,0,.14); }
    .brand{ display:flex; align-items:baseline; gap:10px; }
    h1{ margin:0; font-size:20px; font-weight:700; letter-spacing:.3px; }
    .tagline{ font-size:13px; opacity:.85; }
    .lang{ display:flex; border:1px solid rgba(255,255,255,.55); border-radius:999px; overflow:hidden; }
    .lang button{ background:transparent; color:#fff; border:none; padding:6px 15px; cursor:pointer; font:inherit; font-size:13px; }
    .lang button.active{ background:#fff; color:var(--brand-dark); font-weight:700; }
    .controls{ display:flex; align-items:center; gap:12px; }
    .theme-toggle{ background:transparent; border:1px solid rgba(255,255,255,.55); color:#fff;
      border-radius:999px; width:38px; height:32px; cursor:pointer; font-size:15px; line-height:1; }
    .theme-toggle:hover{ background:rgba(255,255,255,.15); }
    nav{ display:flex; gap:8px; flex-wrap:wrap; padding:18px 28px 0; }
    nav button{ cursor:pointer; border:1px solid var(--line); border-radius:999px; background:var(--card);
      padding:8px 16px; font:inherit; font-size:14px; color:var(--ink); transition:all .15s; }
    nav button:hover{ border-color:var(--brand); color:var(--brand); }
    nav button.active{ background:var(--brand); border-color:var(--brand); color:#fff; font-weight:600; }
    main{ padding:18px 28px 24px; max-width:1240px; }
    .desc{ display:flex; gap:10px; background:var(--accent); border-left:4px solid var(--brand);
      border-radius:8px; padding:12px 16px; margin-bottom:16px; font-size:13.5px; line-height:1.65; color:var(--desc-ink); }
    .desc .icon{ font-size:17px; }
    .toolbar{ display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:14px; }
    input{ font:inherit; padding:8px 12px; border:1px solid var(--line); border-radius:8px; background:#fff; min-width:130px; }
    input:focus{ outline:none; border-color:var(--brand); box-shadow:0 0 0 3px rgba(47,111,159,.15); }
    .btn{ cursor:pointer; border:1px solid var(--brand); border-radius:8px; background:var(--brand);
      color:#fff; padding:8px 16px; font:inherit; transition:opacity .15s; }
    .btn:hover{ opacity:.88; }
    .btn.ghost{ background:#fff; color:var(--brand); }
    .btn:disabled{ opacity:.4; cursor:not-allowed; }
    .status{ min-height:22px; margin-bottom:10px; color:var(--muted); font-size:13px; }
    .status.error{ color:var(--bad); font-weight:600; }
    .card{ background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.05); }
    .table-wrap{ overflow-x:auto; }
    table{ width:100%; border-collapse:collapse; font-size:13.5px; }
    th,td{ padding:10px 14px; text-align:left; border-bottom:1px solid var(--line); vertical-align:top; }
    th{ position:sticky; top:0; background:var(--th-bg); color:var(--th-ink); font-weight:600; white-space:nowrap; z-index:1; }
    tbody tr:nth-child(even){ background:var(--row-even); }
    tbody tr:hover{ background:var(--row-hover); }
    td.text{ min-width:300px; max-width:520px; white-space:pre-wrap; line-height:1.55; }
    td.num{ font-variant-numeric:tabular-nums; text-align:right; }
    .health{ font-variant-numeric:tabular-nums; font-weight:700; text-align:center; }
    .h-ok{ color:var(--ok); } .h-warn{ color:var(--warn); } .h-bad{ color:var(--bad); } .h-none{ color:#aab2bd; }
    .empty{ padding:44px; text-align:center; color:var(--muted); }
    .pager{ display:flex; align-items:center; gap:12px; margin-top:14px; }
    .pager span{ color:var(--muted); font-size:13px; }
    footer{ padding:8px 28px 28px; color:#9aa4b0; font-size:12px; }
  </style>
</head>
<body>
  <header>
    <div class="brand"><h1>🌊 Memory River</h1><span class="tagline" id="tagline"></span></div>
    <div class="controls">
      <button class="theme-toggle" id="theme-toggle" title="切換深色 / Toggle theme">🌙</button>
      <div class="lang">
        <button data-lang="zh" class="active">中文</button>
        <button data-lang="en">EN</button>
      </div>
    </div>
  </header>
  <nav id="tabs"></nav>
  <main>
    <div id="desc" class="desc"></div>
    <div id="toolbar" class="toolbar"></div>
    <div id="status" class="status"></div>
    <div id="content"></div>
    <div id="pager" class="pager"></div>
  </main>
  <footer id="footer"></footer>
  <script>
    var I18N = {
      zh: {
        tagline: '唯讀記憶觀測台 · 綁定本機',
        tabs: { tables:'資料表', effectiveness:'子系統成效', night:'夜間整併', memories:'記憶', graph:'知識圖譜', slots:'結構化參數' },
        desc: {
          tables:'這個 memory-river 實例底層 LanceDB 的所有資料表與筆數,一眼看出資料規模。',
          effectiveness:'各子系統(檢索 / 因果 / 衝突…)被使用後的成效:事件數、結果分佈、方法、分數與健康度。',
          night:'「夜間整併」每次執行的紀錄——AI 的睡眠整理,把零碎記憶合併、去重。',
          memories:'長期記憶的實際內容。健康度越高代表越被信任 / 常用;可搜尋內容、篩分類與狀態。',
          graph:'知識圖譜三元組(主語—關係—賓語),記憶之間的結構化關聯。',
          slots:'結構化參數(精確的鍵 / 值,如偏好、設定),精準取用而非依賴模糊記憶。'
        },
        cols: { name:'名稱', rows:'筆數', subsystem:'子系統', events:'事件數', outcomes:'結果分佈', methods:'方法', scores:'分數', health:'健康度', runId:'執行 ID', source:'來源', verdict:'結果', started:'開始時間', phases:'階段', id:'ID', text:'內容', category:'分類', status:'狀態', importance:'重要性', confidence:'信心', slotKey:'參數鍵', slotValue:'參數值', updated:'更新時間', subject:'主語', relation:'關係', object:'賓語', sourceMemory:'來源記憶', created:'建立時間' },
        ph: { since24:'時間範圍(如 24h)', since7:'時間範圍(如 7d)', subsystem:'子系統 a,b', searchText:'搜尋內容', category:'分類', statusF:'狀態', searchSO:'搜尋主語 / 賓語' },
        refresh:'重新整理', prev:'上一頁', next:'下一頁', loading:'載入中…',
        eventsN:' 筆事件', runsN:' 次執行', empty:'沒有資料', noResult:'0 筆結果', of:' / 共 ', dash:'–',
        footer:'memory-river dashboard · 唯讀 · 不外連 · 不修改任何資料'
      },
      en: {
        tagline: 'Read-only memory observatory · localhost',
        tabs: { tables:'Tables', effectiveness:'Effectiveness', night:'Night', memories:'Memories', graph:'Graph', slots:'Slots' },
        desc: {
          tables:'Every LanceDB table and its row count for this memory-river instance — the data footprint at a glance.',
          effectiveness:'How each subsystem (retrieval / causal / conflict…) performs once used: events, outcome mix, methods, scores, health.',
          night:'Each Night-Consolidation run — the AI\'s "sleep" that merges and de-duplicates fragmented memories.',
          memories:'The actual long-term memory contents. Higher health = more trusted / used. Search text, filter by category & status.',
          graph:'Knowledge-graph triples (subject—relation—object): the structured links between memories.',
          slots:'Structured slots (precise key / value, e.g. preferences, settings) — exact recall, not fuzzy memory.'
        },
        cols: { name:'Name', rows:'Rows', subsystem:'Subsystem', events:'Events', outcomes:'Outcomes', methods:'Methods', scores:'Scores', health:'Health', runId:'Run ID', source:'Source', verdict:'Verdict', started:'Started', phases:'Phases', id:'ID', text:'Text', category:'Category', status:'Status', importance:'Importance', confidence:'Confidence', slotKey:'Slot Key', slotValue:'Slot Value', updated:'Updated', subject:'Subject', relation:'Relation', object:'Object', sourceMemory:'Source Memory', created:'Created' },
        ph: { since24:'Since (e.g. 24h)', since7:'Since (e.g. 7d)', subsystem:'Subsystem a,b', searchText:'Search text', category:'Category', statusF:'Status', searchSO:'Search subject / object' },
        refresh:'Refresh', prev:'Previous', next:'Next', loading:'Loading…',
        eventsN:' events', runsN:' runs', empty:'No data', noResult:'0 results', of:' of ', dash:'–',
        footer:'memory-river dashboard · read-only · no external calls · never modifies data'
      }
    };
    var themeBtn = document.querySelector('#theme-toggle');
    function applyTheme(theme) {
      document.documentElement.dataset.theme = theme;
      themeBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
    applyTheme(localStorage.getItem('mr-theme') || 'light');
    themeBtn.onclick = function () {
      var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('mr-theme', next);
      applyTheme(next);
    };

    var lang = 'zh';
    function t() { return I18N[lang]; }

    var SECTIONS = ['tables', 'effectiveness', 'night', 'memories', 'graph', 'slots'];
    var PAGED = ['memories', 'graph', 'slots'];
    var state = { tab: 'tables', offset: 0, limit: 50 };
    var tabs = document.querySelector('#tabs');
    var descEl = document.querySelector('#desc');
    var toolbar = document.querySelector('#toolbar');
    var statusEl = document.querySelector('#status');
    var content = document.querySelector('#content');
    var pager = document.querySelector('#pager');

    for (var langButton of document.querySelectorAll('.lang button')) {
      langButton.onclick = function () {
        lang = this.dataset.lang;
        for (var other of document.querySelectorAll('.lang button')) other.classList.toggle('active', other.dataset.lang === lang);
        document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
        buildChrome();
        render();
      };
    }

    function buildChrome() {
      tabs.replaceChildren();
      for (var key of SECTIONS) {
        var button = document.createElement('button');
        button.textContent = t().tabs[key];
        button.dataset.tab = key;
        button.onclick = function () { state.tab = this.dataset.tab; state.offset = 0; render(); };
        tabs.append(button);
      }
      document.querySelector('#tagline').textContent = t().tagline;
      document.querySelector('#footer').textContent = t().footer;
    }

    function field(id, placeholder) {
      var input = document.createElement('input');
      input.id = id;
      input.placeholder = placeholder;
      return input;
    }

    function makeButton(label, ghost) {
      var button = document.createElement('button');
      button.className = 'btn' + (ghost ? ' ghost' : '');
      button.textContent = label;
      return button;
    }

    function setupToolbar() {
      toolbar.replaceChildren();
      pager.replaceChildren();
      var ph = t().ph;
      if (state.tab === 'effectiveness') {
        toolbar.append(field('since', ph.since24), field('subsystem', ph.subsystem));
      } else if (state.tab === 'night') {
        toolbar.append(field('since', ph.since7));
      } else if (state.tab === 'memories') {
        toolbar.append(field('q', ph.searchText), field('category', ph.category), field('status-filter', ph.statusF));
      } else if (state.tab === 'graph') {
        toolbar.append(field('q', ph.searchSO));
      }
      var refresh = makeButton(t().refresh);
      refresh.onclick = function () { state.offset = 0; load(); };
      toolbar.append(refresh);
    }

    function params() {
      var query = new URLSearchParams();
      if (PAGED.includes(state.tab)) {
        query.set('limit', state.limit);
        query.set('offset', state.offset);
      }
      for (var id of ['since', 'subsystem', 'q', 'category', 'status-filter']) {
        var input = document.querySelector('#' + id);
        if (input && input.value.trim()) query.set(id === 'status-filter' ? 'status' : id, input.value.trim());
      }
      return query;
    }

    function value(raw) {
      if (raw === null || raw === undefined) return '';
      if (typeof raw === 'object') return JSON.stringify(raw);
      return String(raw);
    }

    function healthClass(raw) {
      if (raw === null || raw === undefined || raw === '') return 'h-none';
      var n = Number(raw);
      if (!isFinite(n)) return 'h-none';
      if (n >= 80) return 'h-ok';
      if (n >= 40) return 'h-warn';
      return 'h-bad';
    }

    function table(items, columns) {
      var card = document.createElement('div');
      card.className = 'card';
      if (!items || !items.length) {
        var empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = t().empty;
        card.append(empty);
        return card;
      }
      var wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      var element = document.createElement('table');
      var head = element.createTHead().insertRow();
      for (var column of columns) {
        var th = document.createElement('th');
        th.textContent = t().cols[column.k];
        head.append(th);
      }
      var body = element.createTBody();
      for (var item of items) {
        var row = body.insertRow();
        for (var col of columns) {
          var cell = row.insertCell();
          var raw = col.get ? col.get(item) : item[col.f];
          cell.textContent = value(raw);
          if (col.cls === 'text') cell.className = 'text';
          else if (col.cls === 'num') cell.className = 'num';
          else if (col.cls === 'health') cell.className = 'health ' + healthClass(raw);
        }
      }
      wrap.append(element);
      card.append(wrap);
      return card;
    }

    function showPager(data) {
      pager.replaceChildren();
      if (!PAGED.includes(state.tab)) return;
      var previous = makeButton(t().prev, true);
      previous.disabled = state.offset === 0;
      previous.onclick = function () { state.offset = Math.max(0, state.offset - state.limit); load(); };
      var next = makeButton(t().next, true);
      next.disabled = state.offset + state.limit >= data.total;
      next.onclick = function () { state.offset += state.limit; load(); };
      var label = document.createElement('span');
      var end = Math.min(data.total, state.offset + data.items.length);
      label.textContent = data.total ? ((state.offset + 1) + t().dash + end + t().of + data.total) : t().noResult;
      pager.append(previous, label, next);
    }

    function draw(data) {
      var built;
      if (state.tab === 'tables') {
        built = table(data.items, [{f:'name',k:'name'}, {f:'rows',k:'rows',cls:'num'}]);
      } else if (state.tab === 'effectiveness') {
        built = table(data.subsystems, [
          {f:'name',k:'subsystem'}, {f:'eventCount',k:'events',cls:'num'},
          {f:'outcomes',k:'outcomes'}, {f:'methods',k:'methods'},
          {f:'scores',k:'scores'}, {f:'health',k:'health'}
        ]);
      } else if (state.tab === 'night') {
        built = table(data.runs, [
          {f:'runId',k:'runId'}, {f:'source',k:'source'},
          {get:function(x){return x.verdict.label;},k:'verdict'}, {f:'firstTs',k:'started'},
          {get:function(x){return x.phases.map(function(p){return p.phase;}).join(' → ');},k:'phases'}
        ]);
      } else if (state.tab === 'memories' || state.tab === 'slots') {
        built = table(data.items, [
          {f:'id',k:'id'}, {f:'text',k:'text',cls:'text'},
          {f:'category',k:'category'}, {f:'status',k:'status'},
          {f:'importance',k:'importance',cls:'num'}, {f:'confidence',k:'confidence',cls:'num'},
          {f:'slotKey',k:'slotKey'}, {f:'slotValue',k:'slotValue'},
          {f:'healthScore',k:'health',cls:'health'}, {f:'updatedAt',k:'updated'}
        ]);
      } else {
        built = table(data.items, [
          {f:'subject',k:'subject'}, {f:'relation',k:'relation'},
          {f:'object',k:'object'}, {f:'sourceMemoryId',k:'sourceMemory'},
          {f:'createdAt',k:'created'}
        ]);
      }
      content.replaceChildren(built);
      showPager(data);
    }

    async function load() {
      statusEl.textContent = t().loading;
      statusEl.className = 'status';
      try {
        var response = await fetch('/api/' + state.tab + '?' + params());
        var data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        draw(data);
        statusEl.textContent = state.tab === 'effectiveness'
          ? (data.totalEvents + t().eventsN)
          : state.tab === 'night' ? (data.totalRuns + t().runsN) : '';
      } catch (error) {
        statusEl.textContent = error.message;
        statusEl.className = 'status error';
        content.replaceChildren();
        pager.replaceChildren();
      }
    }

    function render() {
      for (var button of tabs.children) button.classList.toggle('active', button.dataset.tab === state.tab);
      var icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = '💡';
      var text = document.createElement('span');
      text.textContent = t().desc[state.tab];
      descEl.replaceChildren(icon, text);
      setupToolbar();
      load();
    }

    buildChrome();
    render();
  </script>
</body>
</html>`;

export function createDashboardServer(dbPath: string): Server {
  return createServer(async (request, response) => {
    const result = await handleDashboardRequest(dbPath, request.method ?? 'GET', request.url ?? '/');
    if (result.contentType.startsWith('application/json')) {
      sendJson(response, result.status, result.body);
      return;
    }
    response.writeHead(result.status, {
      'content-type': result.contentType,
      'cache-control': 'no-store',
    });
    response.end(String(result.body));
  });
}

export async function handleDashboardRequest(
  dbPath: string,
  method: string,
  requestUrl: string,
): Promise<DashboardResponse> {
  try {
    const url = new URL(requestUrl, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      if (method !== 'GET') {
        return { status: 405, contentType: 'application/json; charset=utf-8', body: { error: 'method not allowed' } };
      }
      return {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: await apiResponse(dbPath, url),
      };
    }
    if (method !== 'GET') {
      return { status: 405, contentType: 'text/plain; charset=utf-8', body: 'Method not allowed' };
    }
    return { status: 200, contentType: 'text/html; charset=utf-8', body: UI_HTML };
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number(error.statusCode)
      : error instanceof Error && /must be/.test(error.message)
        ? 400
        : 500;
    return {
      status,
      contentType: 'application/json; charset=utf-8',
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function startDashboardServer(dbPath: string, port = 7777): Promise<StartedServer> {
  const server = createDashboardServer(dbPath);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE') {
      throw new Error(`port ${port} is already in use on 127.0.0.1`);
    }
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('server did not provide a TCP address');
  }
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
  };
}
