# GPT Project & Memory Tools 2.33.0 — Test Report

Date: 2026-10-13. Browser: Chrome with a signed-in ChatGPT account (September 2026 UI).

## Root cause of the 2.32.1 failure

Measured on a real project conversation:

| Signal | Count |
|---|---|
| `[data-message-author-role]` in `main` | 0 |
| `article`, `[data-testid^="conversation-turn-"]`, `[data-message-id]` | 0 |
| `[data-turn-key]` (mounted turns) | 5 |
| `[data-chatgpt-search-unit-key]` (mounted messages) | 9 |
| Hidden `div.Workspace-*` wrappers holding previously opened chats | 3 |
| API nodes on the active branch | 717 |

With no role nodes and no turn containers, 2.32.1 fell through to its last fallback and exported `main.innerText` as one message.

The API branch contained 6–9 user messages, 16 assistant answers, 225 assistant tool calls, 57 hidden reasoning blocks and ~400 tool messages, which is why the new reader groups messages into turns instead of exporting every user/assistant API message.

## Results

| Check | Result |
|---|---|
| `node --check` on every `extension/*.js` | PASS |
| `tests/thread-reader.test.mjs` (synthetic payload) | PASS; FAIL on 2.32.1 |
| Live API reader | 18 turns (9 user / 9 assistant), 0 leftover citation markers, 1 attachment line, 1 `sandbox:` link |
| Live page fallback, no sweep | 8 messages, `uauauaua`, no screen-reader headings leaked |
| Live page fallback, scroll sweep | Not verified: the test tab was in the background and Chrome froze its timers |
| Full ZIP with attachments | Not verified live |
| Message navigation | Not verified live |
| Project-memory new-chat injection | Not verified live |
| Composer detection | Selector matches the live editor (`[contenteditable][data-composer-markdown][role=textbox]`) |

## Observed rate limiting

ChatGPT returned HTTP 429 for `/backend-api/conversations` after a burst of conversation reads. The reader caches the conversation for 90 seconds, retries one 429 after `Retry-After`, and otherwise falls back to the page with a visible warning.
