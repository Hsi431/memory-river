import * as lancedb from "@lancedb/lancedb";
import { withTempMemoriesTable } from "./lancedb-temp-db.mjs";

async function test() {
  await withTempMemoriesTable(lancedb, async ({ table }) => {

  const baseRow = {
      id: "test", text: "", textTokens: "", category: "other", importance: 0,
      metadata: "{}", createdAt: 0, updatedAt: 0, vector: Array(1024).fill(0.1)
  };

  console.log("Testing add with undefined importance...");
  try {
    await table.add([{ ...baseRow, importance: undefined }]);
    console.log("Undefined importance OK");
  } catch(e) {
    console.log("Undefined importance add error:", e.message);
  }

  console.log("\nTesting add with null importance...");
  try {
    await table.add([{ ...baseRow, importance: null }]);
    console.log("Null importance OK");
  } catch(e) {
    console.log("Null importance add error:", e.message);
  }

  console.log("\nTesting add with NaN importance...");
  try {
    await table.add([{ ...baseRow, importance: NaN }]);
    console.log("NaN importance OK");
  } catch(e) {
    console.log("NaN importance add error:", e.message);
  }
  });
}

test().catch(console.error);
