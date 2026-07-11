/**
 * Fallback Capsule Test v2
 * 直接呼叫 buildFallbackCapsule (TypeScript private → JS public)
 */
import { ConcentratorAdapter } from './dist/concentrator-adapter.js';

// Mock messages matching ContextMessage structure
const mockMessages = [
  { role: 'system', content: 'You are a helpful assistant.', timestamp: Date.now() - 100000 },
  { role: 'user', content: '我想要設定一個本地端的 AI 推理服務，需要涵蓋 embedding、LLM 推理、還有長期記憶系統。硬體是 AMD Ryzen 9 9950X，記憶體 128GB。', timestamp: Date.now() - 90000 },
  { role: 'assistant', content: '好的！我來幫你規劃一個完整的本地端 AI 架構。需要先確認一些細節：1) 你偏好用哪種 LLM 推理框架？2) embedding 需要支援哪些語言？3) 長期記憶的查詢延遲要求是多少？', timestamp: Date.now() - 85000 },
  { role: 'user', content: 'LLM 推理想要用 llama.cpp，embedding 主要是中文為主、長期記憶的話查詢延遲當然越快越好，但也不想犧牲準確度。', timestamp: Date.now() - 80000 },
  { role: 'assistant', content: '了解了！根據你的需求，我建議以下架構：\n\n1. LLM 推理：llama.cpp + llama-cpp-python server\n2. Embedding：Qwen3-Embedding-0.6B（有 GGUF 量化版）\n3. 長期記憶：LanceDB v4 + CRAG 嚴格過濾\n4. 膠囊濃縮：用 MiniMax 或 Gemini API 做蒸餾\n\n要開始動手建了嗎？', timestamp: Date.now() - 75000 },
  { role: 'user', content: '先從 llama.cpp server 開始架，請問編譯要怎麼做？我想要支援 AMD ROCm，比較能發揮 GPU 效能。', timestamp: Date.now() - 70000 },
  { role: 'assistant', content: '好的，AMD ROCm + llama.cpp 的編譯流程：\n\ngit clone https://github.com/ggml-org/llama.cpp\ncd llama.cpp\ncmake -B build -DAMDGPU=ON -DROCM=on -DCMAKE_C_COMPILER=hipcc -DCMAKE_CXX_COMPILER=hip++\ncmake --build build --config Release -j 32\n\n需要的依賴：rocBLAS、hipBLAS、OpenBLAS。建議用 ROCm 6.1 以上的版本。', timestamp: Date.now() - 65000 },
  { role: 'user', content: '下載好了，要怎麼啟動 llama.cpp server 並且載入 Qwen3-32B 模型？請給我完整的啟動指令。', timestamp: Date.now() - 50000 },
  { role: 'assistant', content: '啟動 llama.cpp server 的指令：\n\n./build/bin/llama-server -m /tmp/models/Qwen3-32B-Q4_K_M.gguf -c 8192 --host 0.0.0.0 --port 8080 -gpu amd 999 --rocm-v4 --batch-size 2048 -fa\n\n常用參數說明：\n-c 8192：context window\n--batch-size 2048：prompt 處理批次\n-fa：flash attention（大幅加速）\n--rocm-v4：AMD ROCm v4 相容模式', timestamp: Date.now() - 45000 },
  { role: 'user', content: '太好了！API 有正常回應。現在來處理 embedding 部分。我想要在本地跑 Qwen3 embedding，請問要怎麼整合到目前的架構？', timestamp: Date.now() - 30000 },
  { role: 'assistant', content: 'Qwen3 Embedding 的本地整合有幾個選項：\n\n1. transformers.js：最容易，整合到 Node.js 環境\n2. llama.cpp embedding server：跟 LLM server 一起跑\n3. 單獨的 embedding service：用 FastAPI 包裝\n\n建議用 transformers.js + node-onnxruntime 或直接用 @xenova/transformers（memory-river 已經在用了）。', timestamp: Date.now() - 25000 },
];

const adapter = new ConcentratorAdapter({
  minimaxApiKey: 'FAKE_KEY_FOR_TESTING_ONLY_12345',
  minimaxModel: 'MiniMax-M2.5',
  geminiApiKey: 'FAKE_GEMINI_KEY_FOR_TESTING_12345',
  geminiModel: 'gemini-2.5-flash',
  provider: 'minimax',
  inboxPath: '/tmp/memory-river-test-inbox',
  concentrationTarget: 1,
});

console.log('=== Direct buildFallbackCapsule Test ===');
console.log(`Messages count: ${mockMessages.length}`);
console.log(`Estimated tokens: ${adapter.estimateTokens(mockMessages)}`);

// Call buildFallbackCapsule directly (TypeScript private → compiled JS public method)
const fallbackCapsule = adapter.buildFallbackCapsule(mockMessages);

console.log('\n=== buildFallbackCapsule Output ===');
console.log(fallbackCapsule);

console.log('\n=== Verification ===');
console.log(`Output length: ${fallbackCapsule.length} chars`);
console.log(`Has "上下文已被截斷": ${fallbackCapsule.includes('【上下文已被截斷')}`);
console.log(`Has "對話骨架": ${fallbackCapsule.includes('【對話骨架】')}`);
console.log(`Has system messages filtered: ${!fallbackCapsule.includes('You are a helpful assistant')}`);
console.log(`USER messages present: ${fallbackCapsule.includes('USER:')}`);
console.log(`ASSISTANT messages present: ${fallbackCapsule.includes('ASSISTANT:')}`);
console.log(`Truncation at 80 chars: ${fallbackCapsule.includes('...')}`);

// Test 2: Empty-ish messages (should produce minimal skeleton)
console.log('\n=== Test 2: Minimal messages ===');
const minimalMsgs = [
  { role: 'user', content: 'hi', timestamp: Date.now() },
  { role: 'assistant', content: 'hello', timestamp: Date.now() },
];
const minimalCapsule = adapter.buildFallbackCapsule(minimalMsgs);
console.log('Minimal capsule:');
console.log(minimalCapsule);

// Test 3: System messages should be filtered out
console.log('\n=== Test 3: System filter ===');
const withSystemMsgs = [
  { role: 'system', content: 'IMPORTANT SYSTEM PROMPT - NEVER IGNORE THIS', timestamp: Date.now() },
  { role: 'user', content: 'tell me about the system prompt', timestamp: Date.now() },
  { role: 'assistant', content: 'the system prompt tells me to be helpful', timestamp: Date.now() },
];
const systemFiltered = adapter.buildFallbackCapsule(withSystemMsgs);
console.log('System-filtered capsule:');
console.log(systemFiltered);
console.log(`System content preserved: ${systemFiltered.includes('IMPORTANT SYSTEM PROMPT')}`);
