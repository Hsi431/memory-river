import * as lancedb from "@lancedb/lancedb";
import { withTempMemoriesTable } from "./lancedb-temp-db.mjs";

async function test() {
  await withTempMemoriesTable(lancedb, async ({ table }) => {

  const fullEntry = {
    "id": "8aa18104-d5fd-4bc3-a8d6-faadd8eff9bc",
    "text": "test",
    "textTokens": "test",
    "vector": Array(1024).fill(0.1),
    "importance": 0.8,
    "category": "fact",
    "parentId": "a93c209b-caa5-4a76-9b26-4bc8cae00adc",
    "metadata": "{}",
    "createdAt": 1775488211164,
    "updatedAt": 1775488211164,
    // Explicitly providing nulls instead of omitting!
    "slotKey": null,
    "slotValue": null,
    "extractionDomain": null,
    "supersedes": null,
    "confidence": null
  };

  console.log("Testing fullEntry with explicit NULLs for ALL optional cols...");
  try {
    await table.add([fullEntry]);
    console.log("ALL nulls OK");
  } catch(e) {
    console.log("ALL nulls error:", e.message);
  }
  });
}

test().catch(console.error);
