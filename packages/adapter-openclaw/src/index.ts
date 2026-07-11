// === WORKAROUND: OpenClaw 2026.3.28 runtimeContext ReferenceError ===
if (typeof (globalThis as any).runtimeContext === 'undefined') {
  Object.defineProperty(globalThis, 'runtimeContext', { value: {}, writable: true, configurable: true, enumerable: false });
}

import * as fs from 'fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Type } from '@sinclair/typebox';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/memory-core';
import { MemoryRiverEngine, type MemoryRiverEngineDeps } from '@memory-river/core/engine';
import { SkillValidationError } from '@memory-river/core/skills/validate';
import { createRalphLoop } from './ralph-index.js';
import { GraphStore } from '@memory-river/core/store/graph-store';
import { DEFAULT_CONFIG as DEFAULT_CONFIG_WITHOUT_PATHS, type PluginConfig } from '@memory-river/core/types';
import { resolvePaths } from '@memory-river/core/paths';
import { resolveRamDbPath } from '@memory-river/core/storage';
import { createTranscriptArchive } from '@memory-river/core/transcript/transcript-archive';
import { resolveSessionIdentityByGuess } from '@memory-river/core/util/session-identity';
import { rehydrate, rehydrateByTime } from '@memory-river/core/transcript/rehydrate';
import { rehydrateByKeyword } from '@memory-river/core/transcript/rehydrate-keyword';
import {
  buildKeywordSearchTerms,
  matchesKeywordSearch,
  rankKeywordMatches,
} from '@memory-river/core/transcript/keyword-search';
import { shouldRunStartupRecovery, type CleanupState } from '@memory-river/core/lifecycle/cleanup-state';
import type { AsyncCompactRequest } from '@memory-river/core/pipeline/compact-request';
export type { AsyncCompactRequest } from '@memory-river/core/pipeline/compact-request';

const homeDir = process.env.HOME ?? '/root';
const dataDir = path.join(homeDir, '.openclaw', 'memory');
const resolvedPaths = resolvePaths({ dataDir, ramDir: '/dev/shm/memory-river/lancedb-v6-qwen' });
const workspaceDir = process.env.OPENCLAW_WORKSPACE ?? path.join(homeDir, '.openclaw', 'workspace');
const paths = {
  ...resolvedPaths,
  transcriptsDir: process.env.MEMORY_TRANSCRIPT_PATH ?? resolvedPaths.transcriptsDir,
  sessionSummaryDir: path.join(workspaceDir, 'memory', 'sessions'),
  rerankerCacheDir: path.join(homeDir, '.cache', 'huggingface'),
};
const transcriptArchive = createTranscriptArchive(paths.transcriptsDir);
const DEFAULT_CONFIG: Required<PluginConfig> = {
  ...DEFAULT_CONFIG_WITHOUT_PATHS,
  dbPath: path.join(dataDir, 'lancedb-v6-qwen'),
  ramDbPath: '/dev/shm/memory-river/lancedb-v6-qwen',
  storageMode: 'auto',
  inboxPath: paths.inboxDir,
};

function createOpenClawNotifier() {
  const discordChannelId = process.env.DISCORD_CHANNEL_ID?.trim();
  if (!discordChannelId) return undefined;
  return { async notify(message: string): Promise<void> {
    execFileSync('openclaw', ['message', 'send', '--channel', 'discord', '--target', discordChannelId, '--message', message], { timeout: 15000, stdio: 'ignore' });
  } };
}

function deriveSessionFileFromStaticRule(args: { sessionId?: string; sessionKey?: string }): string | null {
  const parts = args.sessionKey?.split(':') ?? [];
  const agentId = parts.length >= 2 && parts[0] === 'agent' ? parts[1] : null;
  if (!args.sessionId || !agentId) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(agentId) || agentId.includes('..')) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(args.sessionId) || args.sessionId.includes('..')) return null;
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME ?? '/root', '.openclaw');
  const sessionsDir = path.resolve(stateDir, 'agents', agentId, 'sessions');
  const sessionFile = path.resolve(sessionsDir, `${args.sessionId}.jsonl`);
  const sessionsPrefix = sessionsDir.endsWith(path.sep) ? sessionsDir : `${sessionsDir}${path.sep}`;
  if (!sessionFile.startsWith(sessionsPrefix)) return null;
  console.log(`[sessionMap] static fallback derived: agentId=${agentId} sessionId=${args.sessionId} path=${sessionFile}`);
  return sessionFile;
}

function createEngineDeps(): MemoryRiverEngineDeps {
  return {
    paths,
    transcriptArchive,
    notifier: createOpenClawNotifier(),
    deriveSessionFile: deriveSessionFileFromStaticRule,
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  };
}

const engine = new MemoryRiverEngine(DEFAULT_CONFIG, createEngineDeps());

function deepMerge(target: any, source: any): any {
  if (!source || typeof source !== 'object') return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key]; const tv = target[key];
    result[key] = sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)
      ? deepMerge(tv, sv) : sv;
  }
  return result;
}

function resolveConfiguredStorage(config: Required<PluginConfig>): Required<PluginConfig> {
  return {
    ...config,
    ramDbPath: resolveRamDbPath({
      dbPath: config.dbPath,
      ramDbPath: config.ramDbPath,
      storageMode: config.storageMode,
    }).ramDbPath,
  };
}

function listAvailableSessions(): string[] {
  try { return fs.readdirSync(paths.transcriptsDir).filter(f => f.endsWith('.jsonl') && !f.endsWith('.idx')).map(f => ({ name: f.replace('.jsonl',''), mtime: fs.statSync(path.join(paths.transcriptsDir, f)).mtimeMs })).sort((a,b) => b.mtime-a.mtime).map(x => x.name); } catch { return []; }
}
export interface TranscriptFileSelection { file: string; filePath: string; mtimeMs: number }
export function selectTranscriptFilesForKeywordSearch(transcriptDir: string, limit = 10): TranscriptFileSelection[] { if (!fs.existsSync(transcriptDir)) return []; return fs.readdirSync(transcriptDir).filter(f => f.endsWith('.jsonl') && !f.endsWith('.idx')).map(file => { const filePath=path.join(transcriptDir,file); return {file,filePath,mtimeMs:fs.statSync(filePath).mtimeMs}; }).sort((a,b)=>b.mtimeMs-a.mtimeMs).slice(0,limit); }
export function selectTranscriptFilesForSessionKeywordSearch(transcriptDir: string, sessionKey: string): TranscriptFileSelection[] { if (!fs.existsSync(transcriptDir)) return []; const base=`${sessionKey}.jsonl`; const prefix=`${sessionKey}.`; return fs.readdirSync(transcriptDir).filter(file => file.endsWith('.jsonl') && !file.endsWith('.idx') && (file===base || (file.startsWith(prefix) && /^[0-9]+$/.test(file.slice(prefix.length,-'.jsonl'.length))))).map(file=>{const filePath=path.join(transcriptDir,file);return{file,filePath,mtimeMs:fs.statSync(filePath).mtimeMs};}).sort((a,b)=>b.mtimeMs-a.mtimeMs); }
export { buildKeywordSearchTerms, matchesKeywordSearch, rankKeywordMatches };
export function stripLeadingUntrustedMetadataBlocks(text: string): string { return engine.stripLeadingUntrustedMetadataBlocks(text); }
export function extractLastUserMessage(msgs: any[]): string { return engine.extractLastUserMessage(msgs); }
export function recordHookPromptIncludedEvents(store:any, results:any[], response:any): void { engine.recordHookPromptIncludedEvents(store,results,response); }
export function shouldScheduleStartupRecoveryFromState(state: CleanupState|null, nowMs=Date.now()) { return shouldRunStartupRecovery(state,nowMs); }
export function recordPluginInitSmokeStat(store:any,outcome:'succeeded'|'failed',err?:any) { return engine.recordPluginInitSmokeStat(store,outcome,err); }
export function resolveArchivedLineCount(store:any,key:string,sessionId:string|null) { return engine.resolveArchivedLineCount(store,key,sessionId); }
export function persistArchivedLineCount(store:any,key:string,sessionId:string|null,lineCount:number) { return engine.persistArchivedLineCount(store,key,sessionId,lineCount); }
export function getAsyncCompactConcurrency(): number { return engine.getAsyncCompactConcurrency(); }
export function processAsyncCompactRequest(req: AsyncCompactRequest): Promise<void> { return engine.processAsyncCompactRequest(req); }
export function resolveSessionFile(args:any) { return engine.resolveSessionFile(args); }
export function assemble(...args:any[]) { return engine.assemble(...args); }
export function ingest(...args:any[]) { return engine.ingest(...args); }
export function maintain(params:any) { return engine.maintain(params); }
export function compact(params:any) { return engine.compact(params); }
export const __memoryRiverTestHooks = engine.testHooks;
export const __asyncCompactTestHooks = engine.asyncCompactTestHooks;

const memoryRiver = {
  id: 'memory-river', kind: 'memory' as const, info: { ownsCompaction: true }, assemble, ingest, maintain, compact,
  register(api: OpenClawPluginApi) {
    const config: Required<PluginConfig> = resolveConfiguredStorage(deepMerge(DEFAULT_CONFIG, api.pluginConfig || {}));
    engine.configure(config, createEngineDeps());
    console.log('[memory-river] 🔧 register: config.autoRecall =', config.autoRecall, 'isAutoRecallEnabled =', config.autoRecall);
    const ralphLoop = createRalphLoop(); ralphLoop.register(api);
    const registerTool = api.registerTool as (tool: any, opts?: Parameters<OpenClawPluginApi['registerTool']>[1]) => void;
    api.registerHook('session:compact:before', (event:any) => engine.onSessionCompactBefore(event), { name: 'memory-river-session-compact-before' });
    api.on('session_end', (event:any) => engine.onSessionEnd(event));
    api.on('llm_output', (event:any, ctx:any) => engine.onLlmOutput(event,ctx));
    api.registerService({ id:'memory-river', start(){ engine.start(() => api.logger.info('memory-river: session state cleared on startup')); api.logger.info('memory-river: started'); }, async stop(){ await engine.stop(); } });
    registerTool({ name:'memory_recall', label:'Memory Recall', description:'搜尋長期記憶。', parameters:Type.Object({query:Type.String(),limit:Type.Optional(Type.Number({default:5}))}), execute(_id:any,params:any){return engine.executeMemoryRecall(params);} },{name:'memory_recall'});
    registerTool({ name:'memory_store', label:'Memory Store', description:'儲存長期記憶。', parameters:Type.Object({text:Type.String(),category:Type.Optional(Type.String({default:'other'})),importance:Type.Optional(Type.Number({default:0.7}))}), execute(_id:any,params:any){return engine.executeMemoryStore(params);} },{name:'memory_store'});
    registerTool({
      name: 'skill_save',
      label: 'Skill Save',
      description: '儲存可重複使用的技能流程。',
      parameters: Type.Object({
        name: Type.String(),
        summary: Type.String(),
        triggers: Type.Array(Type.String()),
        steps: Type.Array(Type.String()),
      }),
      async execute(_id: any, params: any) {
        try {
          const saved = await engine.saveSkill(params);
          return { content: [{ type: 'text', text: `skill saved: ${params.name} (${saved.id})` }] };
        } catch (err: any) {
          if (err instanceof SkillValidationError) {
            return { content: [{ type: 'text', text: err.message }], isError: true };
          }
          return {
            content: [{ type: 'text', text: `❌ SKILL_SAVE_FAILED: ${err?.message ?? String(err)}` }],
            isError: true,
          };
        }
      },
    }, { name: 'skill_save' });
    registerTool({
      name: 'skill_load',
      label: 'Skill Load',
      description: '載入技能的完整執行步驟。',
      parameters: Type.Object({ name: Type.String() }),
      async execute(_id: any, params: any) {
        try {
          const skill = await engine.loadSkill(params.name);
          if (!skill) {
            return { content: [{ type: 'text', text: `skill not found: ${params.name}` }] };
          }
          const steps = skill.executionSteps.map((step, index) => `${index + 1}. ${step}`).join('\n');
          const text = [
            `【${skill.name}】`,
            `摘要: ${skill.summary}`,
            `觸發: ${skill.triggerConditions.join(', ')}`,
            `使用次數: ${skill.usageCount}`,
            '執行步驟:',
            steps,
          ].join('\n');
          return { content: [{ type: 'text', text }] };
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: `❌ SKILL_LOAD_FAILED: ${err?.message ?? String(err)}` }],
            isError: true,
          };
        }
      },
    }, { name: 'skill_load' });
    registerTool({ name:'gwm_on', label:'GWM On', description:'啟動全域工作記憶追蹤。當用戶要求你記住任務目標時使用。', parameters:Type.Object({taskName:Type.String({description:'任務名稱（簡短）'}),taskDescription:Type.String({description:'任務詳細描述'}),keywords:Type.Optional(Type.Array(Type.String(),{description:'任務關鍵字（可選，自動從描述提取）'}))}), execute(_id:any,p:any){return engine.executeGwmOn(p);} },{name:'gwm_on'});
    registerTool({ name:'gwm_off', label:'GWM Off', description:'關閉全域工作記憶追蹤。任務完成或用戶要求時使用。', parameters:Type.Object({}), execute(){return engine.executeGwmOff();} },{name:'gwm_off'});
    registerTool({ name:'gwm_status', label:'GWM Status', description:'查看當前全域工作記憶狀態（任務名稱、漂移輪數等）。', parameters:Type.Object({}), execute(){return engine.executeGwmStatus();} },{name:'gwm_status'});
    registerTool({ name:'gwm_update', label:'GWM Update', description:'更新全域工作記憶的任務描述或關鍵字。', parameters:Type.Object({taskName:Type.Optional(Type.String()),taskDescription:Type.Optional(Type.String()),keywords:Type.Optional(Type.Array(Type.String()))}), execute(_id:any,p:any){return engine.executeGwmUpdate(p);} },{name:'gwm_update'});
    // ── 註冊工具：memory_rehydrate ────────────────────────────────────────
    registerTool({
      name: 'memory_rehydrate',
      label: 'Memory Rehydrate',
      description: `取回原始對話原文。count>0 不代表成功，必須確認回傳的 turns 真的包含被問的事實；不足時要換路線再試。

模式優先順序與適用情境：
- entry_ids — 首選、最精確：當某筆相關的 recalled memory 提供 sourceEntryIds 時使用。不要用空泛或答非所問的記憶所提供的 sourceEntryIds。
- time_range — 相關記憶只有時間戳，或使用者提供可信時間時使用。
- keyword — 召回沒有相關記憶時的回退。實際限制：只掃最新約 10 個 transcript 檔；符合任一詞即會命中，命中詞越多排序越前；請使用數個具辨識度的詞（人、物、檔名、專案或罕見詞），並用 offset 翻頁。`,
      parameters: Type.Object({
        mode: Type.Union([
          Type.Literal('entry_ids'),
          Type.Literal('keyword'),
          Type.Literal('time_range'),
        ], { description: '使用情境' }),
        entryIds: Type.Optional(Type.Array(Type.Number(), { description: 'mode=entry_ids 時必填' })),
        keyword: Type.Optional(Type.String({ description: 'mode=keyword 時必填' })),
        timestamp: Type.Optional(Type.String({ description: 'mode=time_range 時用，ISO 時間' })),
        windowMinutes: Type.Optional(Type.Number({ description: 'mode=time_range 窗口半徑', default: 60 })),
        bleed: Type.Optional(Type.Number({ description: '前後擴展筆數', default: 2 })),
        limit: Type.Optional(Type.Integer({ description: '最多回傳幾則', minimum: 1, maximum: 200, default: 10 })),
        offset: Type.Optional(Type.Integer({ description: 'mode=keyword 時從第幾筆排名結果開始回傳', minimum: 0, default: 0 })),
        sessionKey: Type.Optional(Type.String({ description: '可選。指定查哪個 session 的 archive。不傳則預設當前 session (mtime 最新的 jsonl)。' })),
      }),
      async execute(_id: any, input: any) {
        const { mode, entryIds, keyword, timestamp, windowMinutes = 60, bleed = 2, limit = 10, offset = 0, sessionKey: inputSessionKey } = input;

        try {
          if (mode === 'entry_ids') {
            const targetSession = inputSessionKey
              || resolveSessionIdentityByGuess(paths.transcriptsDir, 'memory_rehydrate:entry_ids')?.canonicalKey
              || null;
            if (!targetSession) {
              return { content: [{ type: 'text', text: JSON.stringify({ error: '無法推斷 sessionKey，請明確傳入。', availableSessions: listAvailableSessions().slice(0, 5) }) }], isError: true };
            }
            const archivePath = transcriptArchive.getTranscriptPath(targetSession);
            if (!fs.existsSync(archivePath)) {
              return { content: [{ type: 'text', text: JSON.stringify({ error: `archive not found for session: ${targetSession}`, availableSessions: listAvailableSessions().slice(0, 5) }) }], isError: true };
            }
            if (!entryIds || entryIds.length === 0) {
              return { content: [{ type: 'text', text: JSON.stringify({ error: 'entryIds 不可空' }) }], isError: true };
            }
            const results = await rehydrate(archivePath, entryIds, bleed);
            return { content: [{ type: 'text', text: JSON.stringify({ mode, count: results.length, entries: results.slice(0, limit), usedSession: targetSession }) }] };
          }

          if (mode === 'keyword') {
            if (!keyword) return { content: [{ type: 'text', text: JSON.stringify({ error: 'keyword 不可空' }) }], isError: true };
            const entries = await rehydrateByKeyword(paths.transcriptsDir, keyword, {
              sessionKey: inputSessionKey,
              limit,
              offset,
            });
            const allResults = await rehydrateByKeyword(paths.transcriptsDir, keyword, {
              sessionKey: inputSessionKey,
              limit: 200,
            });
            return { content: [{ type: 'text', text: JSON.stringify({ mode, count: allResults.length, entries }) }] };
          }

          if (mode === 'time_range') {
            const targetSession = inputSessionKey
              || resolveSessionIdentityByGuess(paths.transcriptsDir, 'memory_rehydrate:time_range')?.canonicalKey
              || null;
            if (!targetSession) {
              return { content: [{ type: 'text', text: JSON.stringify({ error: '無法推斷 sessionKey，請明確傳入。', availableSessions: listAvailableSessions().slice(0, 5) }) }], isError: true };
            }
            const archivePath = transcriptArchive.getTranscriptPath(targetSession);
            if (!fs.existsSync(archivePath)) {
              return { content: [{ type: 'text', text: JSON.stringify({ error: `archive not found for session: ${targetSession}`, availableSessions: listAvailableSessions().slice(0, 5) }) }], isError: true };
            }
            if (!timestamp) return { content: [{ type: 'text', text: JSON.stringify({ error: 'timestamp 不可空' }) }], isError: true };
            const results = await rehydrateByTime(archivePath, timestamp, windowMinutes);
            return { content: [{ type: 'text', text: JSON.stringify({ mode, count: results.length, entries: results.slice(0, limit), usedSession: targetSession }) }] };
          }

          return { content: [{ type: 'text', text: JSON.stringify({ error: `unknown mode: ${mode}` }) }], isError: true };
        } catch (err: any) {
          console.error('[memory_rehydrate] 失敗:', err);
          return { content: [{ type: 'text', text: JSON.stringify({ error: err?.message || String(err) }) }], isError: true };
        }
      }
    }, { name: 'memory_rehydrate' });


    if (typeof (api as any).registerContextEngine === 'function') { (api as any).registerContextEngine('memory-river', () => memoryRiver); console.log('[memory-river] ✅ registerContextEngine 已呼叫'); api.logger.info('[memory-river] ✅ 最強記憶大腦上線！'); }
    void engine.init().then(() => engine.store && engine.recordPluginInitSmokeStat(engine.store,'succeeded')).catch(err => { console.error('[memory-river] ❌ plugin lazy init 失敗:',err); if(engine.store) void engine.recordPluginInitSmokeStat(engine.store,'failed',err); });
  },
};
export const register = memoryRiver.register;
export { GraphStore };
export default memoryRiver;
