// Local full-text search over saved conversations. Pure functions so they run in
// the side panel and in tests alike.

export function normalizeForSearch(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export function tokenize(value) {
  return [...new Set(normalizeForSearch(value).match(/[\p{L}\p{N}_-]{2,}/gu) || [])].slice(0, 40);
}

// Splits a conversation into overlapping-free chunks of whole messages (~1800 chars).
export function chunkConversation(conversation, size = 1800) {
  const chunks = [];
  let current = '';
  for (const message of conversation.messages || []) {
    const block = `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`;
    if (current && (current.length + block.length) > size) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${block}` : block;
    while (current.length > size * 2) {
      chunks.push(current.slice(0, size));
      current = current.slice(size);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function searchRecords(records, query, { limit = 8, perConversation = 2, platform = '', project = '' } = {}) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const phrase = normalizeForSearch(query);
  const hits = [];
  for (const record of records) {
    if (platform && record.platform !== platform) continue;
    if (project && record.project !== project) continue;
    const titleText = normalizeForSearch(`${record.title} ${(record.tags || []).join(' ')} ${record.note || ''}`);
    for (const chunk of record.chunks || chunkConversation(record)) {
      const hay = normalizeForSearch(chunk);
      let score = 0;
      for (const term of terms) {
        const count = hay.split(term).length - 1;
        if (count) score += Math.min(8, count) * 2;
        if (titleText.includes(term)) score += 4;
      }
      if (phrase.length > 5 && hay.includes(phrase)) score += 12;
      if (score <= 1) continue;
      const ageDays = Math.max(0, (Date.now() - new Date(record.updatedAt || record.savedAt || 0).getTime()) / 86400000);
      score += Math.max(0, 3 - Math.log10(ageDays + 1));
      hits.push({ key: record.key, platform: record.platform, title: record.title, url: record.url, updatedAt: record.updatedAt, savedAt: record.savedAt, excerpt: chunk, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  const perKey = new Map();
  const result = [];
  for (const hit of hits) {
    const count = perKey.get(hit.key) || 0;
    if (count >= perConversation) continue;
    perKey.set(hit.key, count + 1);
    result.push(hit);
    if (result.length >= limit) break;
  }
  return result;
}
