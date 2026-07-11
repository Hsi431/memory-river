export function safeRate(hits: number, total: number): number {
  return total > 0 ? hits / total : 0;
}
