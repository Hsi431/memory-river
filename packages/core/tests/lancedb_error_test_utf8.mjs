import * as lancedb from "@lancedb/lancedb";
import { withTempMemoriesTable } from "./lancedb-temp-db.mjs";

async function test() {
  await withTempMemoriesTable(lancedb, async ({ table }) => {

  const baseRow = {
      id: "abc", text: "abc", textTokens: "abc", category: "other", importance: 0,
      metadata: "{}", createdAt: 0, updatedAt: 0, vector: Array(1024).fill(0.1)
  };

  console.log("\nTesting add with text: empty string");
  try {
    await table.add([{ ...baseRow, text: "" }]);
    console.log("text: empty string OK");
  } catch(e) {
    console.log("text empty string error:", e.message);
  }

  console.log("\nTesting add with missing parentId");
  try {
    await table.add([{ ...baseRow, parentId: null }]);
    console.log("missing parent OK");
  } catch(e) {
    console.log("missing parent error:", e.message);
  }
  });
}

test().catch(console.error);
