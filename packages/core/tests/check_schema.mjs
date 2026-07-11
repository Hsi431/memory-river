import * as lancedb from "@lancedb/lancedb";
import { withTempMemoriesTable } from "./lancedb-temp-db.mjs";

async function test() {
  await withTempMemoriesTable(lancedb, async ({ table }) => {
  const schema = await table.schema();
  console.log("Schema Columns:");
  for (const field of schema.fields) {
    console.log(`- ${field.name}: ${field.type}`);
  }
  });
}

test().catch(console.error);
