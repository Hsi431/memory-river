import * as fs from "fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../dist/store/store-v4.js";
import { Embedder } from "../dist/providers/embedder-v5.js";
import { CausalEngine } from "../dist/cognition/causal-engine.js";
import { HooksEngine } from "../dist/cognition/hooks-engine.js";
import { InboxWatcher } from "../dist/pipeline/inbox-watcher.js";

async function test() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mr-test-"));
    const config = { dbPath: path.join(root, "ssd"), ramDbPath: path.join(root, "ram") };
    const inboxPath = path.join(root, "inbox");
    fs.mkdirSync(path.join(inboxPath, "error"), { recursive: true });
    const embedder = new Embedder({
        dimensions: 1024,
        maxRetries: 3,
        ollamaUrl: "http://localhost:11434",
    });
    const store = new MemoryStore(config.dbPath, config.ramDbPath, 1024, {
        initialScore: 50, memoryLossFactor: 0.1, coreCategories: ["user_preference"], coreImportanceThreshold: 0.8
    }, embedder);
    await store.ensureInitialized();
    console.log("MemoryStore initialized");

    const causalEngine = new CausalEngine(store, embedder);
    const hooksEngine = new HooksEngine(store, embedder, { refreshIntervalDays: 7, priorityCategories: [] }, null);
    
    // Create InboxWatcher instance
    const watcher = new InboxWatcher(
        store,
        embedder,
        causalEngine,
        hooksEngine,
        null,
        { generate: async () => "" },
        inboxPath,
        2000,
        undefined,
        { changeStatus: async () => {} },
        async () => {},
    );
    
    const procPath = path.join(inboxPath, "error", "pending_test.json");
    fs.writeFileSync(procPath, JSON.stringify({ text: "test memory", category: "other", importance: 0.5 }), "utf-8");
    
    console.log("Processing manually:", procPath);
    try {
        await watcher._processMemoryEntry(procPath);
        console.log("Success!");
    } catch (e) {
        console.log("Failed with:", e);
    } finally {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch (error) {
            console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
        }
    }
}

test().catch(console.error);
