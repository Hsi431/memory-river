import * as lancedb from "@lancedb/lancedb";
import { withTempMemoriesTable } from "./lancedb-temp-db.mjs";

async function test() {
  await withTempMemoriesTable(lancedb, async ({ table }) => {

  console.log("Testing search with empty array...");
  try {
    await table.search([]).limit(1).toArray();
    console.log("Empty array OK");
  } catch(e) {
    console.log("Empty array error:", e.message);
  }

  console.log("\nTesting search with length 1 array...");
  try {
    await table.search([1]).limit(1).toArray();
    console.log("Length 1 array OK");
  } catch(e) {
    console.log("Length 1 array error:", e.message);
  }

  console.log("\nTesting search with array of undefined...");
  try {
    await table.search(Array(1024).fill(undefined)).limit(1).toArray();
    console.log("Undefined array OK");
  } catch(e) {
    console.log("Undefined array error:", e.message);
  }

  console.log("\nTesting search with array of NaN...");
  try {
    await table.search(Array(1024).fill(NaN)).limit(1).toArray();
    console.log("NaN array OK");
  } catch(e) {
    console.log("NaN array error:", e.message);
  }
  });
}

test().catch(console.error);
