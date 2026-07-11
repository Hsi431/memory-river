import { connectDb } from './shared.js';

export interface TableSummary {
  name: string;
  rows: number;
}

export async function getTablesSummary(dbPath: string): Promise<TableSummary[]> {
  const db = await connectDb(dbPath);
  const tableNames = (await db.tableNames()).sort();
  return Promise.all(tableNames.map(async name => {
    const table = await db.openTable(name);
    return { name, rows: await table.countRows() };
  }));
}

export async function runTables(dbPath: string): Promise<void> {
  const tables = await getTablesSummary(dbPath);

  console.log(`LanceDB tables: ${dbPath}`);
  if (tables.length === 0) {
    console.log('(no tables)');
    return;
  }

  for (const table of tables) {
    console.log(`${table.name}\t${table.rows} rows`);
  }
}
