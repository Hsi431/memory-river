export const AUX_TABLE_WRITE_MAINTENANCE_INTERVAL = 500;
export const AUX_TABLE_VERSION_RETENTION_MS = 60 * 60 * 1000;

const writeCounts = new WeakMap<object, number>();
const maintenanceInFlight = new WeakMap<object, Promise<void>>();

export async function optimizeAuxTable(
  table: any,
  label: string,
  cleanupAgeMs = AUX_TABLE_VERSION_RETENTION_MS,
): Promise<void> {
  if (!table) return;

  const existing = maintenanceInFlight.get(table);
  if (existing) {
    await existing;
    return;
  }

  const maintenance = (async () => {
    try {
      await table.optimize({
        cleanupOlderThan: new Date(Date.now() - cleanupAgeMs),
      });
    } catch (err: any) {
      console.warn(`[AuxTableMaintenance] ${label} optimize failed (non-fatal):`, err?.message ?? err);
    }
  })();

  maintenanceInFlight.set(table, maintenance);
  try {
    await maintenance;
  } finally {
    maintenanceInFlight.delete(table);
  }
}

export async function recordAuxTableWrite(
  table: any,
  label: string,
  cleanupAgeMs = AUX_TABLE_VERSION_RETENTION_MS,
): Promise<void> {
  if (!table || (typeof table !== "object" && typeof table !== "function")) return;

  const next = (writeCounts.get(table) ?? 0) + 1;
  if (next < AUX_TABLE_WRITE_MAINTENANCE_INTERVAL) {
    writeCounts.set(table, next);
    return;
  }

  writeCounts.set(table, 0);
  await optimizeAuxTable(table, label, cleanupAgeMs);
}

export async function optimizeAuxTablesInConnection(db: any, label: string): Promise<void> {
  if (!db) return;

  let tableNames: string[];
  try {
    tableNames = await db.tableNames();
  } catch (err: any) {
    console.warn(`[AuxTableMaintenance] ${label} table listing failed (non-fatal):`, err?.message ?? err);
    return;
  }

  for (const tableName of tableNames) {
    if (tableName === "memories") continue;
    try {
      const table = await db.openTable(tableName);
      await optimizeAuxTable(table, `${label}:${tableName}`);
    } catch (err: any) {
      console.warn(
        `[AuxTableMaintenance] ${label}:${tableName} maintenance failed (non-fatal):`,
        err?.message ?? err,
      );
    }
  }
}
