import { MemoryStore } from '../dist/store/store-v4.js';

const [ssdPath, ramPath, walPath] = process.argv.slice(2);
const store = new MemoryStore(ssdPath, ramPath, 4, walPath);
await store.ensureInitialized();

const appendWal = store.appendWal.bind(store);
store.appendWal = async (...args) => {
  const txnId = await appendWal(...args);
  process.send?.({ phase: 'wal-synced' });
  await new Promise((resolve) => process.once('message', resolve));
  return txnId;
};

const add = store.ramTable.add.bind(store.ramTable);
store.ramTable.add = async (...args) => {
  process.send?.({ phase: 'ram-add-start' });
  return await add(...args);
};

void store.store({
  text: 'SIGKILL during LanceDB add',
  vector: [0.1, 0.2, 0.3, 0.4],
  importance: 0.5,
  category: 'other',
  parentId: null,
  metadata: '{}',
}).catch((err) => {
  process.send?.({ phase: 'error', message: err.message });
});
