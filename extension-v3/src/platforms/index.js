import * as chatgpt from './chatgpt.js';
import * as claude from './claude.js';
import * as gemini from './gemini.js';
import * as grok from './grok.js';

export const platforms = [chatgpt, claude, gemini, grok];

export function platformFor(url) {
  return platforms.find((platform) => platform.matches(url)) || null;
}

export function platformById(id) {
  return platforms.find((platform) => platform.id === id) || null;
}

// Host permissions to request (chat sites plus file hosts).
export const allOrigins = platforms.flatMap((platform) => platform.origins);
// Only the chat pages themselves (for content scripts and tab queries).
export const chatOrigins = platforms.flatMap((platform) => platform.chatOrigins || platform.origins);
