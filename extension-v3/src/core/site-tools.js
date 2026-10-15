import { readSelection, extractReadableWebpage, readActiveYoutubeCaptions, readYoutubeTranscriptPanel, extractYoutubeTranscript } from './site-extract.js';

// Site tools (ported from 2.x): send the selected text, the readable page, a
// screenshot of the visible area, or YouTube subtitles to a new chat in any
// supported assistant. Limits are the 2.x values.
export const MAX_SELECTION = 30000;
export const MAX_PAGE_TEXT = 27000;
export const MAX_TRANSCRIPT = 26000;

export function isYoutubeVideo(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (host === 'youtube.com' || host.endsWith('.youtube.com')) && (parsed.pathname === '/watch' || parsed.pathname.startsWith('/shorts/'));
  } catch (_) {
    return false;
  }
}

async function run(tabId, func, args, world = 'ISOLATED') {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world });
  return result?.result;
}

export async function readFromTab(tab, kind, language = 'en') {
  if (kind === 'selection') return run(tab.id, readSelection, [MAX_SELECTION]);
  if (kind === 'page') return run(tab.id, extractReadableWebpage, [MAX_PAGE_TEXT]);
  if (kind === 'youtube') {
    // Same order as 2.x: player captions, the open transcript panel, then the
    // caption tracks from the player response.
    for (const [func, args] of [
      [readActiveYoutubeCaptions, [language, MAX_TRANSCRIPT]],
      [readYoutubeTranscriptPanel, [MAX_TRANSCRIPT]],
      [extractYoutubeTranscript, [language, MAX_TRANSCRIPT]]
    ]) {
      const result = await run(tab.id, func, args, 'MAIN').catch(() => null);
      if (result?.text) return result;
    }
    return null;
  }
  throw new Error(`unknown kind ${kind}`);
}

export function buildSiteText(kind, result, labels, sourceUrl) {
  const shortened = result.truncated ? `\n\n${labels.shortened}` : '';
  if (kind === 'selection') {
    return `${labels.title}: ${String(result.title || '').trim()}\n${labels.source}: ${sourceUrl}\n\n${labels.selection}:\n${String(result.text || '').trim()}${shortened}`;
  }
  if (kind === 'youtube') {
    const language = String(result.languageName || result.languageCode || '').trim();
    const languageLine = language ? `${labels.language}: ${language}${result.automatic ? ` (${labels.automatic})` : ''}\n` : '';
    return `${labels.title}: ${String(result.title || '').trim()}\n${labels.source}: ${sourceUrl}\n${languageLine}\n${labels.transcript}:\n${String(result.text || '').trim()}${shortened}`;
  }
  return `${labels.title}: ${String(result.title || '').trim().slice(0, 500)}\n${labels.source}: ${String(result.url || sourceUrl).slice(0, 2000)}\n\n${labels.pageContent}:\n${String(result.text || '').trim()}${shortened}`;
}

export async function captureVisible(windowId) {
  return chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 88 });
}

export const SITE_KINDS = ['selection', 'page', 'screenshot', 'youtube'];

// Reads what the user asked for from the tab: { kind, title, url, text } or
// { kind, title, url, image, filename }. Needs activeTab (toolbar icon or
// context menu click) on that tab. Errors: 'site-no-access', 'site-empty'.
export async function prepareSiteJob(tab, kind, labels, language = 'en') {
  const base = { kind, title: String(tab?.title || ''), url: String(tab?.url || '') };
  try {
    if (kind === 'screenshot') {
      const image = await captureVisible(tab.windowId);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      return { ...base, image, filename: `screenshot-${stamp}.jpg` };
    }
    // The YouTube readers swallow their errors, so check access first.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => true });
    const result = await readFromTab(tab, kind, language);
    if (!String(result?.text || '').trim()) throw new Error('site-empty');
    return { ...base, text: buildSiteText(kind, result, labels, base.url) };
  } catch (error) {
    const message = String(error?.message || error);
    if (message === 'site-empty') throw error;
    // "Cannot access contents of the page", "activeTab permission not in effect", …
    throw new Error(/permission|cannot access|cannot be scripted|not in effect|chrome:\/\//i.test(message) ? 'site-no-access' : message);
  }
}
