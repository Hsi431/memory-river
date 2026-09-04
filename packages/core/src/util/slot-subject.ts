export function normalizeSlotSubject(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

export function getEffectiveSlotSubject(metadata: { slotSubject?: unknown; subject?: unknown }): string | null {
  return normalizeSlotSubject(metadata.slotSubject) ?? normalizeSlotSubject(metadata.subject);
}

export function maySupersede(newSubject: unknown, oldSubject: unknown): boolean {
  const normalizedNewSubject = normalizeSlotSubject(newSubject);
  const normalizedOldSubject = normalizeSlotSubject(oldSubject);

  return (normalizedNewSubject === null && normalizedOldSubject === null)
    || (normalizedNewSubject !== null && normalizedNewSubject === normalizedOldSubject);
}

export function mayCardinalitySupersede(newCardinality: unknown, oldCardinality: unknown): boolean {
  const normalizedNewCardinality = typeof newCardinality === 'string'
    ? newCardinality.trim().toLowerCase()
    : null;
  const normalizedOldCardinality = typeof oldCardinality === 'string'
    ? oldCardinality.trim().toLowerCase()
    : null;

  return normalizedNewCardinality !== 'multi' && normalizedOldCardinality !== 'multi';
}
