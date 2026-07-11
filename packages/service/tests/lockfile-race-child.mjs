import { acquireServiceLock } from '../dist/lockfile.js';

process.send?.({ ready: true });
await new Promise((resolve) => process.once('message', resolve));

try {
  const lock = await acquireServiceLock(process.argv[2]);
  process.send?.({ acquired: true });
  await new Promise((resolve) => process.once('message', resolve));
  await lock.release();
} catch (error) {
  process.send?.({ acquired: false, message: error instanceof Error ? error.message : String(error) });
}
