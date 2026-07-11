# @memory-river/core

**給 agent 的三層記憶 — 會褪色的工作摘要、會留存的事實、以及永遠能回頭重讀的完整原文。**

[English](./README.md)

大多數「agent 記憶」就是一個 vector store 加一顆儲存鍵:一坨平的 embedding,你往裡寫、往裡搜。Memory River 是一套**模擬真實記憶運作**的記憶*系統* — 它把資訊保存在**三種時間尺度**、用**兩段式**檢索、讓記憶隨時間**代謝**,而且任何被蒸餾出來的東西都能**追溯回它來自哪幾句原文**。embedding 和 LLM 由你注入,引擎本身不綁任何宿主框架。

> `0.1.x` 是早期 API,升版前請先看變更。

## 核心概念:三種時間尺度的記憶

當對話長過水位線,Memory River 不是把舊對話截掉就算了 — 它把舊對話**蒸餾**成三種時間尺度的記憶:

- **短期 — session 膠囊。** 剛剛發生了什麼的精簡前情提要,注入下一個 prompt 頂端,讓模型在舊對話被裁切後仍接得上脈絡。它起始健康度低、**代謝得快** — 這是*這次 session* 的工作記憶,不是事實庫。膠囊會依領域自適應:寫程式的 session 給結構化任務摘要,閒聊給自然語言前情提要。
- **中期 — 蒸餾筆記。** 每顆膠囊旁邊,會抽出幾條顆粒化、可獨立理解的事實,當作一般記憶寫進庫裡。它們起始滿血、**會留存** — 幾天後 `recall` 撈到的就是這些。
- **長期 — 原始 transcript。** 每一句對話都逐字歸檔,帶 byte-offset 索引;膠囊會記下它摘要了哪幾句確切原文 — 所以壓縮不會真的丟失任何東西。

## 兩段式檢索

1. **粗召回(自動、便宜)。** 模型回合前,`assembleContext` 注入最相關的少數幾條記憶。永遠開著。
2. **Rehydrate(精確、按需)。** 失真的記憶會帶著回指原文的指標;agent 呼叫 `rehydrate`,用 entry-id、時間窗或關鍵字撈回**確切的原始對話** — 逐字的數字、人名、日期。

常態很便宜(你不必每回合重載整段對話),但精確細節永遠只差一跳。這也讓 Memory River **可稽核**:每一條蒸餾出的結論,都能追回產生它的那幾句原文。

## 會代謝的記憶

記憶不是寫一次就不動的列。它們**會活**:健康度隨時間衰減、被存取就回血;新事實會**取代**相近的舊事實;矛盾會被**標記並 deprecated**,而不是默默並存;夜間有一趟把冗餘記憶**合併**;歸零的記憶走 trash 保護路徑清掉。核心類別、高重要性事實、技能膠囊免於衰減 — 所以記憶庫保持相關,而不是長成一堆雜訊。

## 怎麼蓋起來的

| 子系統 | 做什麼 | 模組 |
| --- | --- | --- |
| 雙層儲存 + WAL | RAM 目錄(可放 tmpfs)做熱讀、資料目錄做持久層、write-ahead log 含當機恢復 | `store/store-v4` |
| 蒸餾管線 | 舊對話被摘成膠囊 + 顆粒化筆記,經非同步 inbox 寫入 — 寫入永不阻塞對話 | `distill/concentrator-adapter` + `pipeline/inbox-watcher` |
| Transcript + rehydrate | 逐字原文歸檔 + byte-offset `.idx`;用 entry-id、時間、關鍵字撈回確切原文 | `transcript/` |
| Hybrid 檢索 | 向量 + 全文 BM25、RRF 融合、可選的本地 cross-encoder rerank(CRAG 式 accept/partial/reject,調在 recall 安全端)、EntitySynergyMerger(NER 碎片搶救)、Structured Slot 去重、因果鏈上下文擴展 | `retrieval/retriever-v4` |
| 知識圖譜 | 三元組(subject–relation–object)儲存,向量 + FTS 實體搜尋,供鉤子做語意查詢擴展 | `store/graph-store` |
| 記憶代謝 | 健康度隨時間衰減、被存取就回血;歸零的記憶走 trash 保護路徑清掉 | `lifecycle/cleanup-engine` |
| 夜間整理 | 週期性離線合併、壓縮相關記憶 | `lifecycle/night-consolidation` |
| 聯想鉤子 | 記憶可帶觸發關鍵字,命中時連帶喚起相關記憶;命中成效有回饋閉環動態調權 | `cognition/hooks-engine` |
| 因果 + 衝突 | 新事實取代相近舊事實;矛盾被標記並 deprecated 並記 `supersededBy` 追溯鏈 | `cognition/causal-engine` + `conflict-detector` |
| Structured Slot | 寫入時抽結構化參數(slotKey/slotValue)+ 版本鏈;檢索時同 slot 只回最新 active | `pipeline/inbox-watcher` + `retrieval/retriever-v4` |
| 全局工作記憶 (GWM) | 追蹤長對話主任務,embedding 漂移偵測,偏題時注入提醒拉回 | `cognition/global-working-memory` |
| 技能膠囊 v2 | 顯式儲存的程序性知識,漸進式揭露:平時只注入一行索引,要用才載入完整步驟 | `engine` + `skills/` |
| Ralph Loop | context 斷路器:連續失敗時修剪 / 截斷 context、注入警告,防 context 爆掉 | `cognition/ralph-core` |
| 可觀測性 | 每個子系統 best-effort 寫統計列(`subsystem_effectiveness`、`status_audit_log`…),事後可稽核 | 遍布全系統 |

以上每一項都是現在 code 裡真的有的 — 這份 README 刻意不描述任何「願景」。

## 需求

- Node.js 20
- 一個 `EmbeddingProvider`(內建 `OllamaEmbedding` 可直接用)
- 一個 `LlmClient`(任何「prompt 進、文字出」的函式 — 見 Quick Start)
- 兩個可寫目錄(`dataDir` 持久層、`ramDir` 熱層 — 有 tmpfs 用 tmpfs,一般磁碟目錄也行)

可選的原生依賴都能優雅降級:`nodejieba`(中日韓斷詞,缺了退回逐字切)、`@xenova/transformers`(本地 reranker,缺了直通)。

## 安裝

```bash
npm install @memory-river/core
```

在這個 monorepo 裡:

```bash
npm ci
npm run build -w @memory-river/core
```

## Quick Start

repo 裡的 [`example-cli`](../example-cli/src/cli.ts)(約 110 行)就是一個完整的非 OpenClaw 整合,embedding 和聊天都走 Ollama:

```bash
ollama pull hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF
ollama pull qwen3:8b
npm run build -ws

node packages/example-cli/dist/cli.js remember "老闆喜歡手沖咖啡"
node packages/example-cli/dist/cli.js recall "咖啡"
node packages/example-cli/dist/cli.js chat
```

等價的 core 寫法(完整版見英文 README,只差字串語言):

```ts
import { createMemoryRiver, OllamaEmbedding } from '@memory-river/core';

const river = createMemoryRiver(
  {
    dataDir: '/var/lib/my-agent/memory-river',
    ramDir: '/var/lib/my-agent/memory-river/ram',
    autoRecall: true,
  },
  { embedder, llm },  // 你注入的 EmbeddingProvider 與 LlmClient
);

await river.start();
try {
  await river.remember('老闆喜歡手沖咖啡', { category: 'preference', importance: 0.8 });
  console.log(await river.recall('咖啡', 5));
} finally {
  await river.stop();
}
```

`start()` 初始化引擎、啟動 inbox watcher、排程維護;`stop()` 停掉 watcher 與 timer 並關閉儲存層。

## API

`createMemoryRiver(config, deps)` 回傳:

| API | 用途 |
| --- | --- |
| `start()` / `stop()` | 引擎生命週期。 |
| `remember(text, opts?)` | 存記憶,可帶 category、importance、metadata。 |
| `recall(query, limit?)` | hybrid 檢索的排序結果。 |
| `assembleContext(messages, session?)` | 模型回合前,把相關記憶(與技能索引)注入訊息列。 |
| `skills.save / load / search / list` | 技能膠囊 v2,見下節。 |
| `rehydrate(request)` | 按 ID、時間範圍或關鍵字撈回歸檔的逐字稿。 |
| `archiveTranscript(session, messages)` | 把宿主訊息寫入逐字稿歸檔。 |
| `compactSessionFile(session, opts?)` | 有 `SessionFileAccess` 時壓縮宿主 session 檔。 |
| `gwm.on/off/status/update` | Global Working Memory(目標追蹤 + 漂移偵測)。 |
| `maintenance.runCleanup()` / `runNightConsolidation()` | 手動觸發維護。 |

`MemoryRiverConfig` 只有 `dataDir` 與 `ramDir` 必填,其餘(`embedding`、`retrieval`、`cleanup`、`health`、`hooks`、`causalEngine`、`concentration`、`autoRecall`、`driftThreshold`…)皆可選,與預設值合併。

## 技能膠囊 v2

技能是 agent **顯式儲存**的程序 — 系統永遠不會自動生成技能:

```ts
await river.skills.save({
  name: 'git-release',
  summary: '照標準流程打 tag 出 release',
  triggers: ['發版', 'release'],
  steps: ['跑完整測試', 'git tag -s vX.Y.Z', 'git push --tags', '寫 release notes'],
});
```

- **漸進式揭露**:`assembleContext` 只注入一行索引(`【git-release】觸發: … → skill_load("git-release")`);完整步驟在 agent 呼叫 `skills.load` 之前是零 token 成本。
- **誠實的使用統計**:只有 `load` 會 +1 `usageCount` — 被注入不算被使用。
- **生命週期**:技能的衰減速度是一般記憶的 1/4,每次 load 回血;沒人用的技能會慢慢淡出,不會永遠佔著索引名額。
- **確定性品質閘**:格式不合的定義會被拒收,所有違規一次列完 — 不用 LLM 評審、不做沉默修正。

## 依賴 Ports

外部服務由宿主擁有。必填:`embedder`、`llm`。可選:`logger`、`notifier`、`sessionFiles`。

```ts
interface EmbeddingProvider {
  embed(text: string, mode?: 'store' | 'query'): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  getDimensions(): number;
  healthCheck?(): Promise<boolean>;
}

interface LlmClient {
  generate(prompt: string, opts?: { purpose?: string; maxTokens?: number }): Promise<string>;
}
```

供應商選擇、重試、fallback、限流都屬於你的 `LlmClient` — core 刻意不內建多供應商 fallback 鏈。

`Logger` 預設走 console,`Notifier` 預設靜默。沒接 `SessionFileAccess` 時,逐字稿歸檔與 rehydrate 照常運作,只有 `compactSessionFile()` 變 no-op。

## 移植到別的 agent 宿主

1. 準備可寫的 `dataDir` + `ramDir`。
2. 實作 `EmbeddingProvider`(或直接用 `OllamaEmbedding`)。
3. 實作 `LlmClient`(任何 OpenAI 相容端點約 20 行)。
4. `createMemoryRiver(...)`,宿主啟動時 `start()`、關閉時 `stop()`。
5. 把 `remember` / `recall`(可加 `skills.save` / `skills.load`)掛成宿主的 tool。

到這裡就是一個能用的整合 — `example-cli` 就是這五步,總共約 110 行。第 6–9 步是可選的進階層:對話過 `assembleContext`、歸檔逐字稿供 `rehydrate`、接 `SessionFileAccess` 做 session 檔壓縮、接 `Logger`/`Notifier`。

## 持久性說明

LanceDB 雙層儲存 + WAL。insert 在回應前先落 WAL;replay 冪等,失敗會保留 log 供下次重試。本套件**不**宣稱 exactly-once recovery 或零資料遺失 — 請把資料目錄當應用程式狀態看待,照你宿主的標準備份。

## 授權

Apache-2.0 © 2026 Hsi431。寬鬆條款,自由使用、修改、嵌入、出貨。詳見 repo 根目錄的 [LICENSE](../../LICENSE)。
