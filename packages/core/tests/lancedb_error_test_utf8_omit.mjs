import * as lancedb from "@lancedb/lancedb";
import { withTempMemoriesTable } from "./lancedb-temp-db.mjs";

async function test() {
  await withTempMemoriesTable(lancedb, async ({ table }) => {

  const baseRow = {
      id: "abc2", text: "abc", textTokens: "abc", category: "other", importance: 0,
      metadata: "{}", createdAt: 0, updatedAt: 0, vector: Array(1024).fill(0.1)
  };

  console.log("\nTesting add with omitted parentId...");
  try {
    await table.add([{ ...baseRow }]);
    console.log("omitted parent OK");
  } catch(e) {
    console.log("omitted parent error:", e.message);
  }
  });
}

test().catch(console.error);
