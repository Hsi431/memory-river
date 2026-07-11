import * as lancedb from "@lancedb/lancedb";
import { withTempMemoriesTable } from "./lancedb-temp-db.mjs";

async function test() {
  await withTempMemoriesTable(lancedb, async ({ table }) => {

  const baseRow = {
      id: "test", text: "", textTokens: "", category: "other", importance: 0,
      metadata: "{}", createdAt: 0, updatedAt: 0, vector: Array(1024).fill(0.1)
  };

  console.log("Testing add with importance: []...");
  try {
    await table.add([{ ...baseRow, importance: [] }]);
    console.log("importance: [] OK");
  } catch(e) {
    console.log("importance: [] add error:", e.message);
  }

  console.log("\nTesting add with confidence: []...");
  try {
    await table.add([{ ...baseRow, confidence: [] }]);
    console.log("confidence: [] OK");
  } catch(e) {
    console.log("confidence: [] add error:", e.message);
  }
  });
}

test().catch(console.error);
