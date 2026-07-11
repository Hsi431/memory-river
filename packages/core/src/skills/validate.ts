import type { SkillDef } from '../types.js';

const SKILL_NAME_RE = /^[\p{L}\p{N}_-]{1,50}$/u;

function charLength(value: string): number {
  return Array.from(value).length;
}

function received(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

export class SkillValidationError extends Error {
  constructor(public readonly violations: string[]) {
    super(
      `skill_save rejected (${violations.length} violations):\n`
      + violations.map((violation, index) => `${index + 1}. ${violation}`).join('\n'),
    );
    this.name = 'SkillValidationError';
  }
}

export function validateSkillDef(def: SkillDef): void {
  const violations: string[] = [];

  if (typeof def?.name !== 'string' || !SKILL_NAME_RE.test(def.name)) {
    violations.push(`skillName: 不符 /^[\\p{L}\\p{N}_-]{1,50}$/u（收到 ${received(def?.name)}）`);
  }

  if (typeof def?.summary !== 'string') {
    violations.push(`summary: 需為字串（收到 ${received(def?.summary)}）`);
  } else if (charLength(def.summary) < 1 || charLength(def.summary) > 200) {
    violations.push(`summary: 需 1–200 chars（收到 ${charLength(def.summary)}）`);
  }

  if (!Array.isArray(def?.triggers)) {
    violations.push(`triggerConditions: 需 1–5 條（收到 ${received(def?.triggers)}）`);
  } else {
    if (def.triggers.length < 1 || def.triggers.length > 5) {
      violations.push(`triggerConditions: 需 1–5 條（收到 ${def.triggers.length}）`);
    }
    const seen = new Set<string>();
    def.triggers.forEach((trigger, index) => {
      if (typeof trigger !== 'string') {
        violations.push(`triggerConditions[${index}]: 需為字串（收到 ${received(trigger)}）`);
        return;
      }
      if (charLength(trigger) > 100) {
        violations.push(`triggerConditions[${index}]: 超過 100 chars（收到 ${charLength(trigger)}）`);
      }
      if (seen.has(trigger)) {
        violations.push(`triggerConditions[${index}]: 不得重複（收到 ${received(trigger)}）`);
      }
      seen.add(trigger);
    });
  }

  if (!Array.isArray(def?.steps)) {
    violations.push(`executionSteps: 需 2–15 步（收到 ${received(def?.steps)}）`);
  } else {
    if (def.steps.length < 2 || def.steps.length > 15) {
      violations.push(`executionSteps: 需 2–15 步（收到 ${def.steps.length}）`);
    }
    def.steps.forEach((step, index) => {
      if (typeof step !== 'string') {
        violations.push(`executionSteps[${index}]: 需為字串（收到 ${received(step)}）`);
      } else if (charLength(step) > 300) {
        violations.push(`executionSteps[${index}]: 超過 300 chars（收到 ${charLength(step)}）`);
      }
    });
  }

  if (violations.length > 0) {
    throw new SkillValidationError(violations);
  }
}
