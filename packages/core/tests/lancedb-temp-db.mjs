import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const baseMemoryRow = {
  id: "8aa18104-d5fd-4bc3-a8d6-faadd8eff9bc",
  text: "seed",
  textTokens: "seed",
  vector: Array(1024).fill(0.1),
  importance: 0.5,
  category: "other",
  parentId: "",
  metadata: "{}",
  createdAt: 1775488211164,
  updatedAt: 1775488211164,
  confidence: 0,
  slotKey: "",
  slotValue: "",
  extractionDomain: "",
  supersedes: "",
};

export async function withTempMemoriesTable(lancedb, fn, seedRows = [baseMemoryRow]) {
  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "mr-test-"));
  try {
    const db = await lancedb.connect(dbPath);
    const table = await db.createTable("memories", seedRows);
    return await fn({ dbPath, db, table });
  } finally {
    fs.rmSync(dbPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
