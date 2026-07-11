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
    "updatedAt": 1775488211164
  };

  const strCols = ["slotKey", "slotValue", "extractionDomain", "supersedes"];

  console.log("Testing base fullEntry with all optional cols omitted...");
  try {
    await table.add([fullEntry]);
    console.log("omitted ALL OK");
  } catch(e) {
    console.log("omitted ALL error:", e.message);
  }

  for (let i = 0; i < strCols.length; i++) {
      for (let omit = 0; omit < strCols.length; omit++) {
          const testObj = { ...fullEntry };
          for (let fill = 0; fill < strCols.length; fill++) {
              if (fill !== omit) {
                  testObj[strCols[fill]] = "dummy";
              }
          }
          console.log(`Testing omitting only ${strCols[omit]}...`);
          try {
              await table.add([testObj]);
              console.log(`omitted ${strCols[omit]} OK`);
          } catch(e) {
              console.log(`omitted ${strCols[omit]} error:`, e.message);
          }
      }
      break;
  }
  });
}

test().catch(console.error);
