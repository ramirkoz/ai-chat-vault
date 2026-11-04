// Asks for a store rating after real use. The counter is local; nothing leaves the browser.
const KEY = 'ratingPrompt';
const FIRST_AFTER = 5;
const SNOOZE_BY = 20;

export const REVIEW_URL = 'https://chromewebstore.google.com/detail/ingagbhapppiiiccljbhiledobnmhhfb/reviews';

async function read() {
  const { [KEY]: saved } = await chrome.storage.local.get(KEY);
  return { exports: 0, next: FIRST_AFTER, closed: false, ...saved };
}

// Counts one finished export; true when the request should be shown.
export async function noteExport() {
  const state = await read();
  state.exports += 1;
  await chrome.storage.local.set({ [KEY]: state });
  return !state.closed && state.exports >= state.next;
}

export async function snoozeRating() {
  const state = await read();
  await chrome.storage.local.set({ [KEY]: { ...state, next: state.exports + SNOOZE_BY } });
}

export async function closeRating() {
  const state = await read();
  await chrome.storage.local.set({ [KEY]: { ...state, closed: true } });
}
