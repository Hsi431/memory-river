/**
 * rebuild-bm25-index.ts
 * 重建 BM25 / FTS 索引（每天排程用）
 * 使用 LanceDB native createIndex(replace: true) 重建 textTokens FTS 索引
 */
import { MemoryStore } from "@memory-river/core/store/store-v4";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME!;

const DB_PATH    = path.join(HOME, ".openclaw/memory/lancedb-v4");
const RAM_PATH   = "/dev/shm/memory-river";
const VECTOR_DIM = 3072;

async function main() {
  console.log("[BM25 Rebuild] 啟動...");
  console.log(`[BM25 Rebuild] DB=${DB_PATH}`);
  console.log(`[BM25 Rebuild] RAM=${RAM_PATH}`);

  const store = new MemoryStore(DB_PATH, RAM_PATH, VECTOR_DIM);

  // Trigger lazy init（內部第一次操作時自動初始化）
  console.log("[BM25 Rebuild] 等待初始化...");
  await store.count();

  const tables: { table: any; label: string }[] = [
    { table: (store as any).ramTable, label: "RAM" },
    { table: (store as any).ssdTable, label: "SSD" },
  ];

  for (const { table, label } of tables) {
    if (!table) {
      console.warn(`[BM25 Rebuild] [${label}] table 未就緒，略過`);
      continue;
    }
    try {
      await table.createIndex("textTokens", {
        config: { type: "fts" },
        replace: true,
      });
      console.log(`[BM25 Rebuild] [${label}] ✅ FTS index 重建完成`);
    } catch (err: any) {
      console.error(`[BM25 Rebuild] [${label}] ❌ 重建失敗:`, err.message);
    }
  }

  console.log("[BM25 Rebuild] 完成");
  process.exit(0);
}

main().catch((err) => {
  console.error("[BM25 Rebuild] 錯誤:", err);
  process.exit(1);
});
