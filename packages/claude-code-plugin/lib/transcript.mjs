export const MAX_ARCHIVE_MESSAGES = 4000;

function roleFromEntry(entry) {
  const role = entry?.message?.role ?? entry?.role ?? entry?.type;
  return role === 'user' || role === 'assistant' ? role : null;
}

function contentFromEntry(entry) {
  return entry?.message?.content ?? entry?.content;
}

function timestampFromEntry(entry) {
  const raw = entry?.message?.timestamp ?? entry?.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

export function extractTextContent(content) {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join('\n').trim();
}

export function transcriptJsonlToMessages(raw) {
  const messages = [];

  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) {
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const role = roleFromEntry(entry);
    if (!role) {
      continue;
    }

    const content = extractTextContent(contentFromEntry(entry));
    if (!content) {
      continue;
    }

    const message = { role, content };
    const timestamp = timestampFromEntry(entry);
    if (timestamp !== undefined) {
      message.timestamp = timestamp;
    }
    messages.push(message);
  }

  return messages;
}

export function tailArchiveMessages(messages, stderr = process.stderr) {
  if (messages.length <= MAX_ARCHIVE_MESSAGES) {
    return messages;
  }

  try {
    stderr.write(
      `[memory-river] transcript has ${messages.length} messages; archiving last ${MAX_ARCHIVE_MESSAGES}\n`,
    );
  } catch {
    // Best-effort diagnostic only.
  }
  return messages.slice(-MAX_ARCHIVE_MESSAGES);
}
