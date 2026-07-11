import * as lancedb from "@lancedb/lancedb";
import { withTempMemoriesTable } from "./lancedb-temp-db.mjs";

async function test() {
  await withTempMemoriesTable(lancedb, async ({ table }) => {

  const baseRow = {
      id: "test", text: "", textTokens: "", category: "other", importance: 0,
      metadata: "{}", createdAt: 0, updatedAt: 0
  };

  console.log("Testing add with empty array...");
  try {
    await table.add([{ ...baseRow, vector: [] }]);
    console.log("Empty array OK");
  } catch(e) {
    console.log("Empty array add error:", e.message);
  }

  console.log("\nTesting add with undefined...");
  try {
    await table.add([{ ...baseRow, vector: undefined }]);
    console.log("Undefined OK");
  } catch(e) {
    console.log("Undefined add error:", e.message);
  }

  console.log("\nTesting add with array of undefined...");
  try {
    await table.add([{ ...baseRow, vector: Array(1024).fill(undefined) }]);
    console.log("Array of undefined OK");
  } catch(e) {
    console.log("Array of undefined add error:", e.message);
  }

  console.log("\nTesting add with array of NaN...");
  try {
    await table.add([{ ...baseRow, vector: Array(1024).fill(NaN) }]);
    console.log("Array of NaN OK");
  } catch(e) {
    console.log("Array of NaN add error:", e.message);
  }
  });
}

test().catch(console.error);
