import fs from 'node:fs';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';

const HOME = process.env.HOME ?? '/root';
const DB_PATH = process.env.MEMORY_DB_PATH ?? path.join(HOME, '.openclaw/memory/lancedb-v6-qwen');
const OUT_DIR = path.join(process.cwd(), 'docs/data');
const OUT_FILE = path.join(OUT_DIR, 'skill_capsules_legacy_2026-04-12.json');

function stamp(iso) {
  return iso.replace(/[:.]/g, '-');
}

async function main() {
  const db = await lancedb.connect(DB_PATH);
  const tableNames = await db.tableNames();
  if (!tableNames.includes('skill_capsules')) {
    throw new Error(`table "skill_capsules" not found in ${DB_PATH}`);
  }

  const table = await db.openTable('skill_capsules');
  const capsules = await table.query().limit(1000000).toArray();
  capsules.sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));

  const dumpedAt = new Date().toISOString();
  const payload = {
    dumpedAt,
    totalCount: capsules.length,
    schemaVersion: 'v1',
    note: 'Legacy skill_capsules from 2026-04-12 batch.\nSee docs/analysis/SKILL_CAPSULE_DATA_AUDIT_2026-05-09.md\nfor audit findings. Pending human review for v2 seed selection.',
    capsules,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (fs.existsSync(OUT_FILE)) {
    const backup = OUT_FILE.replace(/\.json$/, `.${stamp(dumpedAt)}.json`);
    fs.renameSync(OUT_FILE, backup);
    console.log(`[dump-skill-capsules] existing dump moved to ${path.relative(process.cwd(), backup)}`);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
  console.log(`[dump-skill-capsules] wrote ${capsules.length} capsules to ${path.relative(process.cwd(), OUT_FILE)}`);
}

main().catch((err) => {
  console.error('[dump-skill-capsules] failed:', err?.message ?? err);
  process.exitCode = 1;
});
