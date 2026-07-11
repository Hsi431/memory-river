import * as lancedb from "@lancedb/lancedb";
import { withTempMemoriesTable } from "./lancedb-temp-db.mjs";

async function test() {
  await withTempMemoriesTable(lancedb, async ({ table }) => {

  const baseRow = {
      id: "test2", text: "", textTokens: "", category: "other", importance: 0,
      metadata: "{}", createdAt: 0, updatedAt: 0, vector: Array(1024).fill(0.1)
  };

  console.log("\nTesting add with confidence: undefined explicitly...");
  try {
    await table.add([{ ...baseRow, confidence: undefined }]);
    console.log("confidence: undefined OK");
  } catch(e) {
    console.log("confidence: undefined add error:", e.message);
  }
  });
}

test().catch(console.error);
