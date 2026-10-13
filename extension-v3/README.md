# AI Chat Memory Tools 3.0 (preview)

One local tool for ChatGPT, Claude, Gemini and Grok: read the open conversation, export it, keep it in a searchable library, and continue it in another assistant. No server, no telemetry; everything stays in this browser profile.

## Status

| Platform | Read (API) | Read (page fallback) | Insert into chat | Verified live |
|---|---|---|---|---|
| ChatGPT | `/backend-api/conversation/{id}` | message units + scroll sweep | ✅ | API reader (2026-10-13) |
| Claude | `/api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages` | user/response blocks + scroll sweep | ✅ | normalizer on 6 real chats (2–172 messages) |
| Gemini | `batchexecute` RPC `hNvQHb` | `<user-query>` / `<model-response>` | ✅ | RPC + normalizer on 8 real chats |
| Grok | `/rest/app-chat/conversations/{id}/…` | generic | ✅ | **not verified** (no signed-in account during development) |

## Install (developer mode)

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** → select the `extension-v3` folder.
3. Click the toolbar icon: the side panel opens next to the chat.

Version 3.0 is a separate extension and does not touch 2.x data. Both can be installed side by side while testing.

## What it does

- **Conversation tab**: reads the open chat (API first; the page is used only when the API fails, with a visible warning), lists the messages with role filter and selection, exports Markdown / HTML / JSON, copies, saves to the library.
- **Continue in…**: builds a transcript prompt from the selected messages (oldest messages are dropped first above 24 000 characters), opens a new chat in the chosen assistant and puts the text into its input. It is never sent automatically; the text is also copied to the clipboard as a fallback.
- **Library tab**: saved chats from every assistant in one IndexedDB store, full-text search, platform filter, open/delete, JSON backup and restore. Search results can be inserted as a context block in front of the current message in any supported chat.

## Layout

```
manifest.json            MV3, optional host access per platform
sidepanel.html           UI shell
src/background.js        opens the side panel from the toolbar icon
src/platforms/*.js       one adapter per platform: URL matching, fetchRaw (runs in the page), normalize (pure)
src/core/model.js        unified Conversation / Message model
src/core/reader.js       API-first read with page fallback and a 90 s cache
src/core/export.js       Markdown, safe HTML, JSON
src/core/handoff.js      continue-in prompt and library context block
src/core/search.js       chunking and scoring (pure)
src/core/library.js      IndexedDB storage, backup/restore
src/page/page-kit.js     injected helper: DOM → markdown, scroll sweep, composer insertion
src/ui/                  side panel logic, styles, uk/en strings
```

Adding a platform means adding one adapter file with `matches`, `conversationIdFromUrl`, `fetchRaw`, `normalize`, `dom` and `composerSelectors`, plus a fixture test in `tests/v3/platforms.test.mjs`.

## Tests

```bash
node --test tests/v3/platforms.test.mjs tests/v3/core.test.mjs
```

## Not in this preview yet

- Full ZIP export with attachments (2.x feature) for the new platforms.
- Automatic project memory (2.x auto-sync and first-message injection).
- Grok live verification.
