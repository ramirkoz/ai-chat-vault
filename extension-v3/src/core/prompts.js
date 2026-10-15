// Local prompt library (ported from 2.x prompt-library.js, now in
// chrome.storage.local so the service worker and panel share it).
const KEY = 'prompts';
export const MAX_PROMPTS = 300;
export const MAX_TITLE = 120;
export const MAX_CONTENT = 12000;

export function cleanPrompt(prompt) {
  const now = new Date().toISOString();
  return {
    id: String(prompt?.id || crypto.randomUUID()),
    title: String(prompt?.title || '').trim().slice(0, MAX_TITLE),
    content: String(prompt?.content || '').trim().slice(0, MAX_CONTENT),
    createdAt: String(prompt?.createdAt || now),
    updatedAt: String(prompt?.updatedAt || prompt?.createdAt || now)
  };
}

export function sortPrompts(prompts) {
  return [...prompts].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function filterPrompts(prompts, query) {
  const needle = String(query || '').normalize('NFKC').toLocaleLowerCase().trim();
  if (!needle) return prompts;
  return prompts.filter((prompt) => `${prompt.title}\n${prompt.content}`.normalize('NFKC').toLocaleLowerCase().includes(needle));
}

export async function listPrompts() {
  const { [KEY]: prompts = [] } = await chrome.storage.local.get(KEY);
  return sortPrompts(Array.isArray(prompts) ? prompts.map(cleanPrompt) : []);
}

async function store(prompts) {
  await chrome.storage.local.set({ [KEY]: prompts.slice(0, MAX_PROMPTS) });
}

export async function savePrompt(input) {
  const prompts = await listPrompts();
  const existing = prompts.find((prompt) => prompt.id === input.id);
  const prompt = cleanPrompt({ ...existing, ...input, updatedAt: new Date().toISOString() });
  if (!prompt.title || !prompt.content) throw new Error('prompt-empty');
  if (!existing && prompts.length >= MAX_PROMPTS) throw new Error('prompt-limit');
  await store([prompt, ...prompts.filter((item) => item.id !== prompt.id)]);
  return prompt;
}

export async function deletePrompt(id) {
  await store((await listPrompts()).filter((prompt) => prompt.id !== id));
}

// Merges prompts by title + content, so importing twice adds nothing.
export async function importPrompts(incoming) {
  const prompts = await listPrompts();
  const seen = new Set(prompts.map((prompt) => `${prompt.title}\n${prompt.content}`));
  let added = 0;
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const prompt = cleanPrompt(item);
    const key = `${prompt.title}\n${prompt.content}`;
    if (!prompt.title || !prompt.content || seen.has(key)) continue;
    seen.add(key);
    prompts.push(prompt);
    added += 1;
  }
  await store(sortPrompts(prompts));
  return added;
}
