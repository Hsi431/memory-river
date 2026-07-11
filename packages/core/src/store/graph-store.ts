/**
 * Graph Store Engine — 知識圖譜三元組儲存
 * memory-river
 *
 * 在 LanceDB 中建立獨立的 `graph_triples` table，儲存實體關係三元組。
 * 使用 ANN 向量搜尋支援圖譜語意查詢。
 *
 * 設計原則：
 * - 與 MemoryStore 共用同一組 LanceDB 連線（SSD 持久化 + RAM 加速）
 * - 寫入時同步 embed 三元組文字（subject + relation + object）
 * - 查詢時用 findRelatedEntities 做 ANN 相似度搜尋，擴展 Hook trigger
 */

import { randomUUID } from "node:crypto";
import { recordAuxTableWrite } from "./aux-table-maintenance.js";

const GRAPH_TABLE_NAME = "graph_triples";
const SSD_FAILURE_THRESHOLD = 5;
const DEFAULT_SSD_RECOVERY_PROBE_INTERVAL_MS = 60_000;

export interface Triple {
  subject: string;
  relation: string;
  object: string;
}

export interface GraphTriple extends Triple {
  id: string;
  sourceMemoryId: string;
  createdAt: number;
}

interface LanceDB {
  connect(path: string): Promise<any>;
}

let lancedbImportPromise: Promise<any> | null = null;

const loadLanceDB = async (): Promise<any> => {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  return await lancedbImportPromise;
};

// H4: 共用 LanceDB 重試工具（提取自 store-v4.ts）
async function lancedbRetry<T>(operationName: string, fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  let attempt = 1;
  const MAX_TOTAL_BACKOFF_MS = 5000;
  let totalWaited = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const errMsg = err.message || String(err);
      if (errMsg.includes('Commit conflict') || errMsg.includes('concurrent commit')) {
        if (attempt >= maxRetries || totalWaited >= MAX_TOTAL_BACKOFF_MS) {
          throw new Error(`[GraphStore] ${operationName} 遭遇 Commit Conflict，超過重試上限 (${maxRetries} 次 / ${MAX_TOTAL_BACKOFF_MS}ms): ${errMsg}`);
        }
        const backoff = Math.min(Math.floor(Math.random() * 200) + attempt * 150, MAX_TOTAL_BACKOFF_MS - totalWaited);
        console.warn(`[GraphStore] ${operationName} encountered a concurrency conflict; waiting ${backoff}ms before retry attempt ${attempt}...`);
        await new Promise(r => setTimeout(r, backoff));
        totalWaited += backoff;
        attempt++;
      } else {
        throw err;
      }
    }
  }
}

export class GraphStore {
  private ramDb: any = null;
  private ramTable: any = null;
  private ssdDb: any = null;
  private ssdTable: any = null;
  private initPromise: Promise<void> | null = null;
  private embedder: any = null;
  private ssdAvailable = true;
  private ssdConsecutiveFailures = 0;
  private ssdRecoveryProbeTimer: NodeJS.Timeout | null = null;
  private ssdRecoveryProbeInFlight = false;
  private vectorDim: number;

  /**
   * @param ramDb  RAM LanceDB 連接（由 MemoryStore 提供，透過 store.db）
   * @param ssdDb  SSD LanceDB 連接（由 MemoryStore 提供，透過 store.ssd）
   *
   * ⚠️ Connections owned by MemoryStore — do not close.
   * ⚠️ GraphStore MUST be constructed AFTER store.ensureInitialized().
   */
  constructor(
    ramDb: any,
    ssdDb: any,
    embedder: { embed(text: string): Promise<number[]> },
    vectorDim = 1024,
    private readonly ssdRecoveryProbeIntervalMs = DEFAULT_SSD_RECOVERY_PROBE_INTERVAL_MS,
  ) {
    if (!ramDb) throw new Error('[GraphStore] ramDb is null/undefined — was MemoryStore initialized before GraphStore?');
    if (!ssdDb) throw new Error('[GraphStore] ssdDb is null/undefined — was MemoryStore initialized before GraphStore?');
    this.ramDb = ramDb;
    this.ssdDb = ssdDb;
    if (ramDb === ssdDb) this.ssdAvailable = false;
    this.embedder = embedder;
    this.vectorDim = vectorDim;
  }

  private handleSsdSuccess(): void {
    this.ssdConsecutiveFailures = 0;
  }

  private handleSsdError(err: any, operation: string): void {
    if (!this.ssdAvailable) return;
    this.ssdConsecutiveFailures++;
    if (this.ssdConsecutiveFailures < SSD_FAILURE_THRESHOLD) {
      console.warn(
        `[GraphStore] SSD operation failed (${operation}); consecutive failures ${this.ssdConsecutiveFailures}/${SSD_FAILURE_THRESHOLD}: ${err?.message ?? err}`,
      );
      return;
    }

    this.ssdAvailable = false;
    console.log(
      `[GraphStore] SSD failed ${SSD_FAILURE_THRESHOLD} consecutive times; switching to RAM-Only Mode. Last operation: ${operation}. Error: ${err?.message ?? err}`,
    );
    this.startSsdRecoveryProbe();
  }

  private startSsdRecoveryProbe(): void {
    if (this.ssdRecoveryProbeTimer) return;
    this.ssdRecoveryProbeTimer = setInterval(() => {
      void this.probeSsdRecovery();
    }, this.ssdRecoveryProbeIntervalMs);
    this.ssdRecoveryProbeTimer.unref();
  }

  private async probeSsdRecovery(): Promise<void> {
    if (this.ssdAvailable || this.ssdRecoveryProbeInFlight || !this.ssdTable) return;

    this.ssdRecoveryProbeInFlight = true;
    try {
      await this.ssdTable.countRows();
      this.ssdAvailable = true;
      this.handleSsdSuccess();
      this.stopSsdRecoveryProbe();
      console.log("[GraphStore] SSD recovery probe succeeded; leaving RAM-Only Mode");
    } catch (err: any) {
      console.warn(`[GraphStore] SSD recovery probe failed; retries will continue. Error: ${err?.message ?? err}`);
    } finally {
      this.ssdRecoveryProbeInFlight = false;
    }
  }

  private stopSsdRecoveryProbe(): void {
    if (!this.ssdRecoveryProbeTimer) return;
    clearInterval(this.ssdRecoveryProbeTimer);
    this.ssdRecoveryProbeTimer = null;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.ramTable) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    // Connections already set in constructor (shared from MemoryStore).
    // Directory creation and hydration are MemoryStore's responsibility.
    console.log("[GraphStore] Initializing tables using shared MemoryStore connections...");

    this.ramTable = await this.initTable(this.ramDb, "ram");
    this.ssdTable = await this.initTable(this.ssdDb, "ssd");

    console.log("[GraphStore] Initialization complete");
  }

  private async initTable(db: any, label: string): Promise<any> {
    const tables = await db.tableNames();
    let table: any;

    if (tables.includes(GRAPH_TABLE_NAME)) {
      table = await db.openTable(GRAPH_TABLE_NAME);
      console.log(`[GraphStore] [${label}] Opened existing table`);
    } else {
      console.log(`[GraphStore] [${label}] Creating new table...`);
      const initialData = [{
        id: "init_00000000000000000000000000000000",
        subject: "_SYSTEM_INIT_",
        relation: "_",
        object: "_",
        sourceMemoryId: "",
        vector: Array(this.vectorDim).fill(0),
        createdAt: 0,
      }];
      table = await db.createTable(GRAPH_TABLE_NAME, initialData);
      console.log(`[GraphStore] [${label}] New table created`);
    }

    // 確保 FTS index（用於 subject/object 關鍵字搜尋）
    try {
      await table.createIndex("subject", {
        config: { type: "fts" },
        replace: true,
      });
    } catch (err: any) {
      if (!err.message?.includes("already exists")) {
        console.warn(`[GraphStore] [${label}] Failed to create FTS index:`, err.message);
      }
    }

    return table;
  }

  /**
   * 將三元組文字 Embedding 化（用於 ANN 搜尋）
   * 拼接方式：subject + relation + object
   */
  private async embedTriple(triple: Triple): Promise<number[]> {
    const text = `${triple.subject} ${triple.relation} ${triple.object}`;
    try {
      return await this.embedder.embed(text, 'store');
    } catch (err) {
      console.warn(`[GraphStore] embedTriple failed; falling back to zero vector:`, err);
      return Array(this.vectorDim).fill(0);
    }
  }

  /**
   * 寫入單筆三元組
   */
  async addTriple(triple: Triple, sourceMemoryId: string): Promise<GraphTriple> {
    await this.ensureInitialized();

    const embedding = await this.embedTriple(triple);
    const nowMs = Date.now();

    const entry: any = {
      id: randomUUID(),
      subject: triple.subject,
      relation: triple.relation,
      object: triple.object,
      sourceMemoryId,
      vector: embedding,
      createdAt: nowMs,
    };

    await this.ramTable.add([entry]);
    await recordAuxTableWrite(this.ramTable, "ram:graph_triples");
    if (this.ssdAvailable) {
      try {
        await this.ssdTable.add([entry]);
      } catch (err: any) {
        this.handleSsdError(err, "addTriple");
        throw err;
      }
      this.handleSsdSuccess();
      await recordAuxTableWrite(this.ssdTable, "ssd:graph_triples");
    }

    return {
      id: entry.id,
      subject: triple.subject,
      relation: triple.relation,
      object: triple.object,
      sourceMemoryId,
      createdAt: nowMs,
    };
  }

  /**
   * 批量寫入三元組
   */
  async addTriples(triples: Triple[], sourceMemoryId: string): Promise<GraphTriple[]> {
    if (triples.length === 0) return [];

    await this.ensureInitialized();

    const nowMs = Date.now();
    const results: GraphTriple[] = [];

    // 批次 embedding（避免逐筆呼叫浪費時間）
    const texts = triples.map(t => `${t.subject} ${t.relation} ${t.object}`);
    let embeddings: number[][] = [];
    try {
      embeddings = await this.embedder.embedBatch(texts);
    } catch (err) {
      console.warn(`[GraphStore] embedBatch failed; falling back to zero vectors:`, err);
      embeddings = texts.map(() => Array(this.vectorDim).fill(0));
    }

    const entries = triples.map((triple, i) => ({
      id: randomUUID(),
      subject: triple.subject,
      relation: triple.relation,
      object: triple.object,
      sourceMemoryId,
      vector: embeddings[i] || Array(this.vectorDim).fill(0),
      createdAt: nowMs,
    }));

    await this.ramTable.add(entries);
    await recordAuxTableWrite(this.ramTable, "ram:graph_triples");
    if (this.ssdAvailable) {
      try {
        await this.ssdTable.add(entries);
      } catch (err: any) {
        this.handleSsdError(err, "addTriples");
        throw err;
      }
      this.handleSsdSuccess();
      await recordAuxTableWrite(this.ssdTable, "ssd:graph_triples");
    }

    for (const entry of entries) {
      results.push({
        id: entry.id,
        subject: entry.subject,
        relation: entry.relation,
        object: entry.object,
        sourceMemoryId: entry.sourceMemoryId,
        createdAt: entry.createdAt,
      });
    }

    return results;
  }

  /**
   * 用 Query 文字找相關實體（ANN 相似度搜尋）
   * @param queryText 查詢文字
   * @param limit 回傳上限
   */
  async findRelatedEntities(queryText: string, limit = 10): Promise<GraphTriple[]> {
    await this.ensureInitialized();

    if (!queryText || queryText.trim() === "") return [];

    // 先 embed query
    let queryVector: number[] = [];
    try {
      queryVector = await this.embedder.embed(queryText);
    } catch (err) {
      console.warn(`[GraphStore] findRelatedEntities embedding failed:`, err);
      return [];
    }

    if (!queryVector || queryVector.length === 0) return [];

    try {
      const results = await this.ramTable.search(queryVector).limit(limit).toArray();
      return results
        .filter((row: any) => !row.id.startsWith("init_"))
        .map((row: any) => ({
          id: row.id as string,
          subject: row.subject as string,
          relation: row.relation as string,
          object: row.object as string,
          sourceMemoryId: row.sourceMemoryId as string,
          createdAt: Number(row.createdAt) || Date.now(),
        }));
    } catch (err: any) {
      console.warn(`[GraphStore] findRelatedEntities search failed:`, err.message);
      return [];
    }
  }

  /**
   * 找某實體的所有三元組（subject 匹配）
   */
  async findTriplesBySubject(subject: string, limit = 100): Promise<GraphTriple[]> {
    await this.ensureInitialized();

    if (!subject || subject.trim() === "") return [];

    try {
      // subject 精確匹配
      const results = await this.ramTable
        .query()
        .where(`subject = '${subject.replace(/'/g, "''")}'`)
        .limit(limit)
        .toArray();

      return results
        .filter((row: any) => !row.id.startsWith("init_"))
        .map((row: any) => ({
          id: row.id as string,
          subject: row.subject as string,
          relation: row.relation as string,
          object: row.object as string,
          sourceMemoryId: row.sourceMemoryId as string,
          createdAt: Number(row.createdAt) || Date.now(),
        }));
    } catch (err: any) {
      console.warn(`[GraphStore] findTriplesBySubject failed:`, err.message);
      return [];
    }
  }

  /**
   * 找某實體的所有三元組（object 匹配）
   */
  async findTriplesByObject(object: string, limit = 1000): Promise<GraphTriple[]> {
    await this.ensureInitialized();

    if (!object || object.trim() === "") return [];

    try {
      const results = await this.ramTable
        .query()
        .where(`object = '${object.replace(/'/g, "''")}'`)
        .limit(limit)
        .toArray();

      return results
        .filter((row: any) => !row.id.startsWith("init_"))
        .map((row: any) => ({
          id: row.id as string,
          subject: row.subject as string,
          relation: row.relation as string,
          object: row.object as string,
          sourceMemoryId: row.sourceMemoryId as string,
          createdAt: Number(row.createdAt) || Date.now(),
        }));
    } catch (err: any) {
      console.warn(`[GraphStore] findTriplesByObject failed:`, err.message);
      return [];
    }
  }

  async findTriplesByEntity(
    entity: string,
    direction: 'out' | 'in' | 'both' = 'both',
    limit = 1000,
  ): Promise<GraphTriple[]> {
    if (direction === 'out') return this.findTriplesBySubject(entity, limit);
    if (direction === 'in') return this.findTriplesByObject(entity, limit);

    const byId = new Map<string, GraphTriple>();
    for (const triple of await this.findTriplesBySubject(entity, limit)) {
      byId.set(triple.id, triple);
    }
    for (const triple of await this.findTriplesByObject(entity, limit)) {
      byId.set(triple.id, triple);
    }
    return Array.from(byId.values()).slice(0, limit);
  }

  /**
   * 查詢與某記憶 ID 關聯的所有三元組
   */
  async findTriplesByMemoryId(memoryId: string): Promise<GraphTriple[]> {
    await this.ensureInitialized();

    if (!memoryId) return [];

    try {
      const results = await this.ramTable
        .query()
        .where(`\`sourceMemoryId\` = '${memoryId.replace(/'/g, "''")}'`)
        .limit(100)
        .toArray();

      return results
        .filter((row: any) => !row.id.startsWith("init_"))
        .map((row: any) => ({
          id: row.id as string,
          subject: row.subject as string,
          relation: row.relation as string,
          object: row.object as string,
          sourceMemoryId: row.sourceMemoryId as string,
          createdAt: Number(row.createdAt) || Date.now(),
        }));
    } catch (err: any) {
      console.warn(`[GraphStore] findTriplesByMemoryId failed:`, err.message);
      return [];
    }
  }

  /**
   * 圖譜語意擴展：給定 Query，回傳 subject/object 關鍵詞列表
   * 用於 Hook trigger 時擴展 keyword matching 範圍
   *
   * @param queryText 原始 query
   * @param limit 回傳數量上限
   * @returns 擴展後的關鍵詞列表
   */
  async expandQueryKeywords(queryText: string, limit = 5): Promise<string[]> {
    const related = await this.findRelatedEntities(queryText, limit * 2);
    if (related.length === 0) return [];

    const keywords = new Set<string>();

    for (const triple of related) {
      // 將 subject/object 加入 keyword set（去除重複）
      if (triple.subject && triple.subject.length >= 2) {
        keywords.add(triple.subject);
      }
      if (triple.object && triple.object.length >= 2) {
        keywords.add(triple.object);
      }
    }

    return Array.from(keywords).slice(0, limit);
  }

  /**
   * 圖譜語意擴展（完整版）：回傳相關三元組 + 擴展後關鍵詞
   * 供 Hook trigger 時使用
   */
  async semanticExpand(queryText: string, limit = 10): Promise<{
    triples: GraphTriple[];
    expandedKeywords: string[];
  }> {
    const triples = await this.findRelatedEntities(queryText, limit);
    const keywords = await this.expandQueryKeywords(queryText, limit);
    return { triples, expandedKeywords: keywords };
  }

  /** 取得目前圖譜大小（除錯用） */
  async count(): Promise<number> {
    await this.ensureInitialized();
    const total = await this.ramTable.countRows();
    // 扣掉 init_ 系統列
    return Math.max(0, total - 1);
  }

  /** Graceful shutdown — connections owned by MemoryStore, do not close here */
  async shutdown(): Promise<void> {
    console.log("[GraphStore] Shutdown complete (connections remain managed by MemoryStore)");
    this.stopSsdRecoveryProbe();
    this.ramTable = null;
    this.ssdTable = null;
  }
}
