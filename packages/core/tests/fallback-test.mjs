/**
 * Fallback Capsule Test
 * 直接測試 ConcentratorAdapter，在 LLM 全 fail 時觸發 buildFallbackCapsule
 */
import { ConcentratorAdapter } from './dist/concentrator-adapter.js';

// 建立豐富的 mock messages，湊到足以觸發水位線
const mockMessages = [
  { role: 'system', content: 'You are a helpful assistant.', timestamp: Date.now() - 100000 },
  { role: 'user', content: '我想要設定一個本地端的 AI 推理服務，需要涵蓋 embedding、LLM 推理、還有長期記憶系統。硬體是 AMD Ryzen 9 9950X，記憶體 128GB。', timestamp: Date.now() - 90000 },
  { role: 'assistant', content: '好的！我來幫你規劃一個完整的本地端 AI 架構。需要先確認一些細節：1) 你偏好用哪種 LLM 推理框架？2) embedding 需要支援哪些語言？3) 長期記憶的查詢延遲要求是多少？', timestamp: Date.now() - 85000 },
  { role: 'user', content: 'LLM 推理想要用 llama.cpp，embedding 主要是中文為主、長期記憶的話查詢延遲當然越快越好，但也不想犧牲準確度。', timestamp: Date.now() - 80000 },
  { role: 'assistant', content: '了解了！根據你的需求，我建議以下架構：\n\n1. **LLM 推理**：llama.cpp + llama-cpp-python server\n2. **Embedding**：Qwen3-Embedding-0.6B（有 GGUF 量化版）\n3. **長期記憶**：LanceDB v4 + CRAG 嚴格過濾\n4. **膠囊濃縮**：用 MiniMax 或 Gemini API 做蒸餾\n\n要開始動手建了嗎？', timestamp: Date.now() - 75000 },
  { role: 'user', content: '先從 llama.cpp server 開始架，請問編譯要怎麼做？我想要支援 AMD ROCm，比較能發揮 GPU 效能。', timestamp: Date.now() - 70000 },
  { role: 'assistant', content: '好的，AMD ROCm + llama.cpp 的編譯流程：\n\n```bash\ngit clone https://github.com/ggml-org/llama.cpp\ncd llama.cpp\ncmake -B build -DAMDGPU=ON -DROCM=on -DCMAKE_C_COMPILER=hipcc -DCMAKE_CXX_COMPILER=hip++\ncmake --build build --config Release -j 32\n```\n\n需要的依賴：rocBLAS、hipBLAS、OpenBLAS。建議用 ROCm 6.1 以上的版本。', timestamp: Date.now() - 65000 },
  { role: 'user', content: '編譯順利完成後，要怎麼下載模型？我想要用 Qwen3-32B 的 GGUF 版本，要去哪里下載？', timestamp: Date.now() - 60000 },
  { role: 'assistant', content: 'Qwen3-32B 的 GGUF 版本可以從 Hugging Face 下載：\n\n```bash\n# 安裝 hf-transfer 加速下載\npip install hf-transfer\n\n# 下載 Qwen3-32B Q4_K_M 量化版\nHF_HUB_ENABLE_HF_TRANSFER=1 huggingface-cli download Qwen/Qwen3-32B-GGUF Qwen3-32B-Q4_K_M.gguf --local-dir /tmp/models\n```\n\n建議用 Q4_K_M 量化，在 9950X 上執行大約需要 20-22GB VRAM（用 ROCm 共享記憶體）。', timestamp: Date.now() - 55000 },
  { role: 'user', content: '下載好了，要怎麼啟動 llama.cpp server 並且載入 Qwen3-32B 模型？請給我完整的啟動指令。', timestamp: Date.now() - 50000 },
  { role: 'assistant', content: '啟動 llama.cpp server 的指令：\n\n```bash\n./build/bin/llama-server \\\n  -m /tmp/models/Qwen3-32B-Q4_K_M.gguf \\\n  -c 8192 \\\n  --host 0.0.0.0 \\\n  --port 8080 \\\n  -gpu amd 999 \\\n  --rocm-v4 \\\n  --batch-size 2048 \\\n  -fa\n```\n\n常用參數說明：\n- `-c 8192`：context window\n- `--batch-size 2048`：prompt 處理批次\n- `-fa`：flash attention（大幅加速）\n- `--rocm-v4`：AMD ROCm v4 相容模式', timestamp: Date.now() - 45000 },
  { role: 'user', content: 'server 啟動了！測試一下 API，我想要用 curl 發一個 chat completions 的 request，要怎麼做？', timestamp: Date.now() - 40000 },
  { role: 'assistant', content: '用 curl 測試 llama.cpp server 的 chat completions API：\n\n```bash\ncurl http://localhost:8080/v1/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d \'{\n    "model": "Qwen3-32B",\n    "messages": [\n      {"role": "user", "content": "請用繁體中文回答：1+1 等於多少？"}\n    ],\n    "temperature": 0.7,\n    "max_tokens": 500\n  }\'\n```\n\n如果一切正常，你應該會看到 JSON 格式的回應。', timestamp: Date.now() - 35000 },
  { role: 'user', content: '太好了！API 有正常回應。現在來處理 embedding 部分。我想要在本地跑 Qwen3 embedding，請問要怎麼整合到目前的架構？', timestamp: Date.now() - 30000 },
  { role: 'assistant', content: 'Qwen3 Embedding 的本地整合有幾個選項：\n\n1. ** transformers.js**：最容易，整合到 Node.js 環境\n2. **llama.cpp embedding server**：跟 LLM server 一起跑\n3. **單獨的 embedding service**：用 FastAPI 包裝\n\n建議用 transformers.js + node-onnxruntime 或直接用 @xenova/transformers（memory-river 已經在用了）。\n\n你可以這樣初始化：\n```javascript\nimport { pipeline } from "@xenova/transformers";\nconst embedder = await pipeline("feature-extraction", "Xenova/Qwen3-Embedding-0.6B");\n```', timestamp: Date.now() - 25000 },
  { role: 'user', content: '好，先用 transformers.js 這個方向。接下來要處理的問題是：長期記憶系統。我之前看過一個叫 LanceDB 的向量資料庫，memory-river 好像就是用這個。可以介紹一下嗎？', timestamp: Date.now() - 20000 },
  { role: 'assistant', content: 'LanceDB 是一個专门针对 ML 场景优化的向量数据库，特点：\n\n1. **存储计算分离**：向量存在磁盘/对象存储，metadata 分开\n2. **不需要独立服务**：直接嵌入你的应用程序\n3. **支持 OLAP 风格的查询**：适合大量历史记忆的检索\n4. **Python + Node.js 原生支援**\n\nmemory-river 的架構是這樣的：\n- **短期 RAM**：用 @lancedb/lancedb 的 in-memory table 做快速存取\n- **長期 SSD**：用 Persistent table 做持久化\n- **CRAG 嚴格過濾**：避免錯誤記憶被召回影響判斷\n\n要繼續討論記憶系統的實作細節嗎？', timestamp: Date.now() - 15000 },
  { role: 'user', content: '是的，我想了解 memory-river 的架構設計。可以畫一個高層次的架構圖並解釋嗎？另外想知道濃縮（Concentration）機制的觸發條件是什麼？', timestamp: Date.now() - 10000 },
  { role: 'assistant', content: 'memory-river 高層次架構：\n\n```\n┌─────────────────────────────────────────────┐\n│           OpenClaw Agent (你)               │\n└──────────────────┬──────────────────────────┘\n                   │\n         ┌─────────▼──────────┐\n         │  InboxWatcher       │ ←── 新對話抵達\n         └─────────┬──────────┘\n                   │\n    ┌──────────────┼──────────────┐\n    │              │              │\n┌───▼────┐  ┌────▼────┐  ┌─────▼─────┐\n│RAM DB   │  │Concentrator│  │Retriever  │\n│(短期)   │  │Adapter     │  │(長期查詢)  │\n└───┬────┘  └────┬────┘  └─────┬─────┘\n    │              │              │\n    └──────────────┴──────────────┘\n                   │\n         ┌─────────▼──────────┐\n         │  LanceDB (長期)     │\n         └─────────────────────┘\n```\n\n**Concentration 觸發條件**：\n\n根據目前實作，ConcentratorAdapter 採用**動態水位線**：\n- Code 密集對話（>15% code block 或 >25% tool result）：55% 水位\n- 通用對話：60% 水位\n- 輕鬆閒聊（平均每則 <80 字 + emoji >3%）：70% 水位\n\n當對話長度超過 MAX_CONTEXT_WINDOW * 水位線時，觸發濃縮。\n濃縮後產生：**前情提要膠囊（health=30）** + **重要紙條（health=100）**。', timestamp: Date.now() - 5000 },
];

// 用 fake API key 強迫所有 LLM provider 失敗，觸發 fallback
const adapter = new ConcentratorAdapter({
  minimaxApiKey: 'FAKE_KEY_FOR_TESTING_ONLY_12345',
  minimaxModel: 'MiniMax-M2.5',
  geminiApiKey: 'FAKE_GEMINI_KEY_FOR_TESTING_12345',
  geminiModel: 'gemini-2.5-flash',
  provider: 'minimax',
  inboxPath: '/tmp/memory-river-test-inbox',
  // force concentration with very low target
  concentrationTarget: 1,  // 1 token — will definitely trigger concentration
});

console.log('=== Fallback Capsule Test ===');
console.log(`Messages count: ${mockMessages.length}`);
console.log(`Estimated tokens: ${adapter.estimateTokens(mockMessages)}`);

const result = await adapter.concentrate(mockMessages, false, true);

console.log('\n=== Result ===');
console.log(`wasConcentrated: ${result.wasConcentrated}`);
console.log(`summary length: ${result.summary?.length ?? 0}`);
console.log(`output messages count: ${result.messages.length}`);

console.log('\n=== Capsule Content ===');
if (result.summary) {
  console.log(result.summary);
} else {
  console.log('(no summary returned)');
}

console.log('\n=== Check for Fallback Skeleton Pattern ===');
const hasSkeletonPattern = result.summary?.includes('【上下文已被截斷') || 
                           result.summary?.includes('對話骨架');
console.log(`Has fallback skeleton: ${hasSkeletonPattern}`);

console.log('\n=== Inbox files written ===');
try {
  const fs = await import('node:fs');
  const inboxPath = '/tmp/memory-river-test-inbox';
  if (fs.existsSync(inboxPath)) {
    const files = fs.readdirSync(inboxPath);
    console.log(`Files in inbox: ${files.length}`);
    for (const f of files) {
      const content = fs.readFileSync(`${inboxPath}/${f}`, 'utf-8');
      console.log(`--- ${f} ---`);
      console.log(content.substring(0, 300));
      console.log('...');
    }
  } else {
    console.log('(no inbox directory created)');
  }
} catch (e) {
  console.log(`Inbox check error: ${e}`);
}
