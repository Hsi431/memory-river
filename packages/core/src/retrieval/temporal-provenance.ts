export type TemporalRole = 'event_candidate' | 'observation' | 'unknown';

export interface TemporalProvenance {
  role: TemporalRole;
  /** 原始 when,原樣帶出,不做任何時區換算 */
  claimed: { start: string | null; end: string | null; precision: string | null } | null;
  /** 事件日期 YYYY-MM-DD(range 時為起日) */
  eventDate: string | null;
  eventEndDate: string | null;
  /** 觀測日期 YYYY-MM-DD(這段話是哪天講的) */
  observedAt: string | null;
  memoryCreatedAt: number | null;
  /** 要掛在注入文字後面的短標籤;role=unknown 時為 null */
  label: string | null;
}

type RecordValue = Record<string, unknown>;

const DEFAULT_TIME_ZONE = 'Asia/Taipei';
const ONE_MINUTE_MS = 60_000;
const ONE_DAY_MS = 86_400_000;

function asRecord(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : {};
}

function parseMetadata(value: unknown): RecordValue {
  if (typeof value !== 'string') return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseTemporalInstant(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    const epoch = Number(trimmed);
    return Number.isFinite(epoch) ? epoch : null;
  }

  // Offset-less ISO strings depend on the host timezone. Only accept an ISO
  // timestamp with an explicit UTC designator or numeric offset here.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseForAnchorComparison(value: unknown): number | null {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return parseTemporalInstant(value);
}

function isAnchorEquivalent(start: unknown, anchor: unknown): boolean {
  const startMs = parseForAnchorComparison(start);
  const anchorMs = parseForAnchorComparison(anchor);
  return startMs !== null
    && anchorMs !== null
    && Math.abs(startMs - anchorMs) <= ONE_MINUTE_MS;
}

function dayFromRaw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const day = String(value).slice(0, 10);
  return day || null;
}

function dayInTimeZone(value: unknown, timeZone: string): string | null {
  const epoch = parseTemporalInstant(value);
  if (epoch === null) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(epoch));
    const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return fields.year && fields.month && fields.day
      ? `${fields.year}-${fields.month}-${fields.day}`
      : null;
  } catch {
    if (timeZone === DEFAULT_TIME_ZONE) return null;
    return dayInTimeZone(value, DEFAULT_TIME_ZONE);
  }
}

function makeResult(
  claimed: TemporalProvenance['claimed'],
  memoryCreatedAt: number | null,
  role: TemporalRole,
  eventDate: string | null = null,
  eventEndDate: string | null = null,
  observedAt: string | null = null,
  label: string | null = null,
): TemporalProvenance {
  return { role, claimed, eventDate, eventEndDate, observedAt, memoryCreatedAt, label };
}

export function describeMemoryTemporalProvenance(
  input: { metadata?: unknown; createdAt?: unknown },
  options: { timeZone?: string } = {},
): TemporalProvenance {
  const metadata = parseMetadata(input?.metadata);
  const whenValue = metadata.when;
  const when = asRecord(whenValue);
  const hasWhen = whenValue !== null && typeof whenValue === 'object' && !Array.isArray(whenValue);
  const start = hasWhen ? when.start : undefined;
  const end = hasWhen ? when.end : undefined;
  const precision = hasWhen ? when.precision : undefined;
  const claimed = hasWhen
    ? {
        start: asNullableString(start),
        end: asNullableString(end),
        precision: asNullableString(precision),
      }
    : null;
  const memoryCreatedAt = typeof input?.createdAt === 'number' && Number.isFinite(input.createdAt)
    ? input.createdAt
    : null;
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const precisionValue = claimed?.precision;
  const hasStart = start !== null && start !== undefined && String(start) !== '';
  const anchorEquivalent = isAnchorEquivalent(start, when.anchor);

  if (hasStart && (precisionValue === 'date' || precisionValue === 'range') && !anchorEquivalent) {
    const eventDate = dayFromRaw(start);
    const eventEndDate = precisionValue === 'range' ? dayFromRaw(end) : null;
    const label = precisionValue === 'range'
      ? eventDate !== null && eventEndDate !== null
        ? `〔事件期間 ${eventDate}～${eventEndDate}〕`
        : null
      : eventDate !== null
        ? `〔事件日期 ${eventDate}〕`
        : null;
    return makeResult(claimed, memoryCreatedAt, 'event_candidate', eventDate, eventEndDate, null, label);
  }

  if (hasStart && precisionValue === 'datetime' && anchorEquivalent) {
    const observedAt = dayInTimeZone(start, timeZone);
    return makeResult(
      claimed,
      memoryCreatedAt,
      'observation',
      null,
      null,
      observedAt,
      observedAt !== null ? `〔${observedAt} 的對話〕` : null,
    );
  }

  if (hasStart && precisionValue === 'datetime' && !anchorEquivalent) {
    const eventDate = dayInTimeZone(start, timeZone);
    return makeResult(
      claimed,
      memoryCreatedAt,
      'event_candidate',
      eventDate,
      null,
      null,
      eventDate !== null ? `〔事件日期 ${eventDate}(候選)〕` : null,
    );
  }

  const firstTimestamp = metadata.firstTimestamp;
  const lastTimestamp = metadata.lastTimestamp;
  const firstMs = parseTemporalInstant(firstTimestamp);
  const lastMs = parseTemporalInstant(lastTimestamp);
  if (firstMs !== null && lastMs !== null && lastMs - firstMs <= ONE_DAY_MS) {
    const observedAt = dayInTimeZone(firstTimestamp, timeZone);
    return makeResult(
      claimed,
      memoryCreatedAt,
      'observation',
      null,
      null,
      observedAt,
      observedAt !== null ? `〔${observedAt} 的對話〕` : null,
    );
  }

  return makeResult(claimed, memoryCreatedAt, 'unknown');
}
