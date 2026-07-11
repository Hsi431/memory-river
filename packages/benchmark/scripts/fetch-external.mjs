#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(here, '..', 'datasets', 'external');
const outputPath = path.join(outputDir, 'locomo10.json');
const sourceUrl =
  'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';

if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
  console.log(`LoCoMo dataset already present: ${outputPath}`);
  process.exit(0);
}

fs.mkdirSync(outputDir, { recursive: true });
const response = await fetch(sourceUrl);
if (!response.ok) {
  throw new Error(`LoCoMo download failed: HTTP ${response.status}`);
}

const temporaryPath = `${outputPath}.tmp`;
fs.writeFileSync(temporaryPath, Buffer.from(await response.arrayBuffer()));
fs.renameSync(temporaryPath, outputPath);
console.log(`Downloaded LoCoMo dataset: ${outputPath}`);
