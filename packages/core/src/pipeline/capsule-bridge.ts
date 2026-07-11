/**
 * CapsuleBridge — 膠囊統一出口 (無損通道版)
 *
 * 原則：
 * - 所有濃縮膠囊統一經過這裡寫入 shared inbox
 * - inbox 路徑由 adapter 注入
 * - 寫入格式：river_capsule_{timestamp}.txt（讓 inbox-watcher 能識別並處理）
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface CapsuleWriteOptions {
  category?: string;
  importance?: number;
  metadata?: Record<string, unknown>;
  /** 技能膠囊擴展欄位（inbox-watcher 讀取後入庫） */
  capsuleType?: string;
  skillName?: string;
  triggerConditions?: string[];
  executionSteps?: string[];
  confidence?: number;
  health?: number; // 🎯 升格為一等公民：控制記憶代謝週期
}

export class CapsuleBridge {
  private inboxPath: string;

  constructor(inboxPath: string) {
    this.inboxPath = inboxPath;
    if (!fs.existsSync(this.inboxPath)) {
      fs.mkdirSync(this.inboxPath, { recursive: true, mode: 0o700 });
    }
  }

/** 寫入濃縮膠囊到 shared inbox */
  async writeToInbox(
    text: string,
    opts: CapsuleWriteOptions = {}
  ): Promise<string> {
    if (!fs.existsSync(this.inboxPath)) {
      fs.mkdirSync(this.inboxPath, { recursive: true, mode: 0o700 });
    }

    // 🎯 P0 修復:加隨機後綴防同毫秒並行寫互相覆蓋（對照 writeInboxItem 的做法）
    const filename = `river_capsule_${Date.now()}_${randomUUID().slice(0, 8)}.txt`;
    const filePath = path.join(this.inboxPath, filename);

    // 🎯 核心修復：使用展開運算子 (...opts.metadata) 確保所有基因無損繼承
    const capsuleMeta = {
      capsuleType: opts.capsuleType ?? 'working_memory',
      skillName: opts.skillName,
      triggerConditions: opts.triggerConditions ?? [],
      executionSteps: opts.executionSteps ?? [],
      confidence: opts.confidence ?? 0,
      category: opts.category ?? 'history',
      importance: opts.importance ?? 0.5,
      health: opts.health ?? opts.metadata?.health, // 確保 health 不被遺漏
      ...opts.metadata, // 將所有客製化標籤 (如 tags, type) 完整打包
    };

    // 🛠️ P1-5 修復：序列化完整 capsuleMeta（含 confidence/firstTimestamp/lastTimestamp）
    const metaHeader = JSON.stringify({ ...capsuleMeta, timestamp: Date.now() });
    const fileContent = `<!-- CAPSULE_META:${metaHeader} -->\n${text}`;
    // 🛡️ 'wx' flag：檔案已存在就拒絕覆蓋（配合隨機後綴，理論上不該撞名）
    await fs.promises.writeFile(filePath, fileContent, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });

    const logMeta = opts.capsuleType === 'skill_capsule'
      ? ` [技能膠囊:${opts.skillName ?? ''} conf=${opts.confidence ?? 0}]`
      : ` [健康度:${capsuleMeta.health ?? '永久'}]`;
    
    console.log(`[CapsuleBridge] Capsule written to inbox: ${filename} (${text.length} chars)${logMeta}`);
    return filePath;
  }

  /**
   * 直接寫入 inbox JSON item（繞過 inbox-watcher 直接入庫的路徑）
   * 用於 remember() 的高重要性記憶，直接生成完整 entry
   */
  async writeInboxItem(
    text: string,
    opts: CapsuleWriteOptions
  ): Promise<string> {
    if (!fs.existsSync(this.inboxPath)) {
      fs.mkdirSync(this.inboxPath, { recursive: true, mode: 0o700 });
    }

    const filename = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`;
    const filePath = path.join(this.inboxPath, filename);

    // 這裡原本寫得很好，有接住 ...opts.metadata
    const item = {
      text,
      category: opts.category ?? 'other',
      importance: opts.importance ?? 0.5,
      tags: opts.metadata?.tags ?? [],
      health: opts.health ?? opts.metadata?.health,
      ...opts.metadata,
    };

    await fs.promises.writeFile(filePath, JSON.stringify(item, null, 2), { encoding: 'utf-8', mode: 0o600 });
    console.log(`[CapsuleBridge] Inbox item written: ${filename} (category=${item.category}, importance=${item.importance})`);
    return filePath;
  }

  /** inbox 目前堆積的膠囊數量（除錯用） */
  getPendingCount(): number {
    if (!fs.existsSync(this.inboxPath)) return 0;
    return fs.readdirSync(this.inboxPath).filter((f) => f.startsWith('river_capsule_')).length;
  }

  /** inbox 目前堆積的 pending JSON 數量 */
  getInboxItemCount(): number {
    if (!fs.existsSync(this.inboxPath)) return 0;
    return fs.readdirSync(this.inboxPath).filter((f) => f.startsWith('pending_') && f.endsWith('.json')).length;
  }
}
