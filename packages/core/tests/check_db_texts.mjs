import * as lancedb from "@lancedb/lancedb";
import { withTempMemoriesTable } from "./lancedb-temp-db.mjs";

async function test() {
  await withTempMemoriesTable(lancedb, async ({ table }) => {
  const records = await table.query().limit(10).toArray();
  for (const r of records) {
    if (r.text.includes("-0.")) {
        console.log(`\nFound vector in text! ID: ${r.id}`);
        console.log(`Text preview: ${r.text.substring(0, 500)}`);
        console.log(`Vector length: ${r.vector?.length}`);
    } else {
        console.log(`\nID: ${r.id}`);
        console.log(`Text: ${r.text.substring(0, 100)}`);
    }
  }
  });
}

test().catch(console.error);
