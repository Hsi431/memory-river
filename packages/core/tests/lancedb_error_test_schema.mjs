import * as lancedb from "@lancedb/lancedb";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

async function test() {
  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "mr-test-"));
  try {
  const db = await lancedb.connect(dbPath);
  const baseRow = {
      id: "abc", text: "abc", textTokens: "abc", category: "other", importance: 0,
      metadata: "{}", createdAt: 0, updatedAt: 0, vector: Array(1024).fill(0.1)
  };
  
  const table = await db.createTable("memories", [baseRow]);

  console.log("Adding schema columns slotKey and extractionDomain");
  await table.add([{ ...baseRow, id: "1", slotKey: "test", extractionDomain: "technical" }]);

  console.log("\nTesting add with omitted slotKey...");
  try {
    await table.add([{ ...baseRow, id: "2" }]);
    console.log("omitted slotKey OK");
  } catch(e) {
    console.log("omitted slotKey error:", e.message);
  }

  console.log("\nTesting add with slotKey: null...");
  try {
    await table.add([{ ...baseRow, id: "3", slotKey: null }]);
    console.log("slotKey: null OK");
  } catch(e) {
    console.log("slotKey: null error:", e.message);
  }

  console.log("\nTesting add with slotKey: empty string...");
  try {
    await table.add([{ ...baseRow, id: "4", slotKey: "" }]);
    console.log("slotKey: empty string OK");
  } catch(e) {
    console.log("slotKey: empty string error:", e.message);
  }
  } finally {
    fs.rmSync(dbPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test().catch(console.error);
