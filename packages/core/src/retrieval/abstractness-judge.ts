const ABSTRACT_STOPWORDS = new Set([
  '用戶', '使用者', '系統', '工具', '方式', '策略', '場景', '方法', '建議',
  '錯誤', '問題', '資訊', '資料', '內容', '結果', '過程', '操作', '執行',
  '功能', '設定', '配置', '流程', '機制', '邏輯', '概念', '應用', '處理',
  '根據', '調整', '傳遞', '解決', '理解', '指令', '完成', '任務', '類型',
  '選用', '需要', '描述', '進行', '推理', '成功', '所有',
]);

const META_NARRATION_PATTERNS: RegExp[] = [
  /^(用戶|使用者|User)\s*(正在|已|將|想要|開始)/,
  /^AI\s*(已|將|提供|選用|理解|執行|完成|建議)/,
  /^系統\s*(已|將|正在|提供|執行)/,
  /^(模型|Model|LLM)\s*(已|將|提供|選用)/,
  /(已成功|已完成).{0,15}(任務|流程|操作|執行)$/,
];

export interface AbstractnessJudgement {
  isAbstract: boolean;
  abstractness: number;
  reasons: string[];
  ruleHits: {
    entityCount: number;
    hasMetaNarration: boolean;
    abstractRatio: number;
  };
}

function isAbstractChineseChunk(word: string): boolean {
  for (const stopword of ABSTRACT_STOPWORDS) {
    if (word.includes(stopword)) return true;
  }
  return false;
}

export function countEntities(text: string): number {
  let count = 0;

  count += (text.match(/\d+/g) || []).length;
  count += (text.match(/(\/[a-zA-Z0-9_\-./]+|[a-zA-Z]:\\[^\s]+)/g) || []).length;
  count += (text.match(/\b[a-z][a-zA-Z0-9_]*[A-Z][a-zA-Z0-9_]*\b/g) || []).length;
  count += (text.match(/[a-zA-Z_][a-zA-Z0-9_]*\(\)/g) || []).length;
  count += (text.match(/[「『"'][^」』"']+[」』"']/g) || []).length;
  count += (text.match(/\b[A-Z][a-zA-Z0-9]+\b/g) || []).length;

  const chineseProperNouns = text.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
  for (const word of chineseProperNouns) {
    if (!isAbstractChineseChunk(word)) count += 0.3;
  }

  return Math.floor(count);
}

export function hasMetaNarration(text: string): boolean {
  return META_NARRATION_PATTERNS.some((pattern) => pattern.test(text));
}

export function abstractNounRatio(text: string): number {
  const tokens = text.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
  if (tokens.length === 0) return 0;

  const abstractCount = tokens.filter((token) => isAbstractChineseChunk(token)).length;
  return abstractCount / tokens.length;
}

export function judgeAbstractness(text: string): AbstractnessJudgement {
  const cleanText = text.replace(/\[#[^\]]+\]/g, '').trim();

  if (text.trim().length < 15) {
    return {
      isAbstract: false,
      abstractness: 0,
      reasons: [],
      ruleHits: { entityCount: 0, hasMetaNarration: false, abstractRatio: 0 },
    };
  }

  const entityCount = countEntities(cleanText);
  const hasMeta = hasMetaNarration(cleanText);
  const abstractRatio = abstractNounRatio(cleanText);

  const reasons: string[] = [];
  if (entityCount < 2) reasons.push('low_entity');
  if (hasMeta) reasons.push('meta_narration');
  if (abstractRatio > 0.3) reasons.push('high_abstract_ratio');

  const isAbstract = entityCount < 2 && (hasMeta || abstractRatio > 0.3);

  let abstractness = 0;
  if (entityCount === 0) abstractness += 0.4;
  else if (entityCount === 1) abstractness += 0.2;
  if (hasMeta) abstractness += 0.3;
  abstractness += Math.min(abstractRatio, 0.5) * 0.6;
  abstractness = Math.min(abstractness, 1.0);

  return {
    isAbstract,
    abstractness,
    reasons,
    ruleHits: {
      entityCount,
      hasMetaNarration: hasMeta,
      abstractRatio,
    },
  };
}
