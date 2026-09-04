export function parseEntryIds(value: string): number[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const entryIds: number[] = [];
  for (const part of trimmed.split(',')) {
    const token = part.trim();
    const single = /^(\d+)$/.exec(token);
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (!single && !range) return [];

    const start = Number(single?.[1] ?? range?.[1]);
    const end = Number(single?.[1] ?? range?.[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return [];
    for (let id = start; ; id++) {
      entryIds.push(id);
      if (id === end) break;
    }
  }
  return entryIds;
}
