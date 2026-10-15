# AI Chat Vault 3.0

One local tool for ChatGPT, Claude, Gemini and Grok: read the open conversation, export it, keep it in a searchable library, and continue it in another assistant. No server, no telemetry; everything stays in this browser profile.

## Status

| Platform | Read (API) | Read (page fallback) | Insert into chat | Verified live |
|---|---|---|---|---|
| ChatGPT | `/backend-api/conversation/{id}` | message units + scroll sweep | ✅ | API reader (2026-10-13) |
| Claude | `/api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages` | user/response blocks + scroll sweep | ✅ | normalizer on 6 real chats (2–172 messages) |
| Gemini | `batchexecute` RPC `hNvQHb` | `<user-query>` / `<model-response>` | ✅ | RPC + normalizer on 8 real chats |
| Grok | `/rest/app-chat/conversations/{id}/response-node` + `load-responses` | user/assistant message bubbles | ✅ | endpoints, attachments and page markup on a real chat; the API publishes the newest answer a few seconds late, so a page/API mismatch is reported |

## Install (developer mode)

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** → select the `extension-v3` folder.
3. Click the toolbar icon: the side panel opens next to the chat.

Installed from the Chrome Web Store as an update of GPT Project & Memory Tools 2.x, version 3.0 moves the 2.x saved chats, prompts and the project-memory switch into its own storage (`src/core/migrate-v2.js`). An unpacked install has a different extension id and starts empty.

## What it does

- **Conversation tab**: reads the open chat (API first; the page is used only when the API fails, with a visible warning), lists the messages with role filter and selection, exports Markdown / HTML / JSON, copies, saves to the library.
- **Continue in…**: builds a transcript prompt from the selected messages (oldest messages are dropped first above 24 000 characters), opens a new chat in the chosen assistant and puts the text into its input. It is never sent automatically; the text is also copied to the clipboard as a fallback.
- **Conversation tab** also has search inside the chat, **Show in chat** (scrolls to the message and highlights it) and **PDF** (print page → Save as PDF).
- **Prompts tab**: local prompt library — search, add/edit/delete, copy, insert into the current chat or a new chat in any assistant, import/export JSON (2.x exports are accepted).
- **Site tab and right-click menu**: selected text, readable page text, a screenshot of the visible area or YouTube subtitles (from YouTube's transcript panel) into a new chat in the chosen assistant. Nothing is sent automatically.
- **Library tab**: folders, tags and notes per chat, folder filter, bulk ZIP export of selected chats (Markdown + `library.json`); saved chats from every assistant in one IndexedDB store, full-text search, platform filter, open/delete, JSON backup and restore. Search results can be inserted as a context block in front of the current message in any supported chat.

## Full ZIP with files

Format **ZIP with files** downloads every file the selected messages reference and packs:

```
<date>_<platform>_<title>/
  conversation.md / .html / .json   transcript; each message links its files
  files/…                           attachments, generated images, created files
  manifest.json                     sizes, SHA-256, which message each file belongs to
  MISSING_FILES.txt                 files that could not be downloaded (nothing is substituted)
```

| Platform | Files | Verified live (2026-10-13) |
|---|---|---|
| ChatGPT | uploads and images (`files/download`), generated images, `sandbox:/mnt/data/…` files (`interpreter/download`); project chats retry with `gizmo_id` | descriptor + bytes for an upload and a sandbox ZIP |
| Claude | text attachments (from the API), images (preview, webp), PDFs (original), uploads and created files (`wiggle/download-file`) | PDF 82 604/82 604 B, upload 50 160/50 160 B, created file, image preview |
| Grok | uploads and generated images on `assets.grok.com` | 221 626 B ZIP upload |
| Gemini | uploaded and generated images, original size (`=s0`), fetched by the extension because googleusercontent.com sends no CORS headers to the chat page | upload entry structure and original 1280×934 / 172 912 B on a real chat |

Identical files are stored once (SHA-256). Limit: 200 MB per file. Exports larger than ~300 MB are split into `….part1.zip`, `….part2.zip`, …; each part is saved as soon as it is full, and the last part carries the transcript, manifest and `README-PARTS.txt`. Extract all parts into one folder.

## Automatic project memory (ChatGPT)

Library tab → **Automatic project memory**. Ported from 2.x:

- Opening a chat in a ChatGPT Project syncs the project's chats into the local library (only new or changed chats are fetched; at most every 10 minutes per project, or on demand with **Sync this project now**).
- When you send the first message of a **new** chat in that project, the most relevant excerpts from the project's other chats are put in front of it as a `[PROJECT MEMORY: …]` block, followed by `[CURRENT REQUEST]` and your text. Nothing is added to ChatGPT's Project Sources.
- Claude Projects are prepared in the architecture but not enabled: no Claude project was available to verify against.

## Test mode (automated testing)

Library tab → **Test mode**. While on (60 minutes at most), a bridge on the four chat sites accepts commands from the page and runs them in the extension:

```js
window.postMessage({ source: 'acm-test', id: 1, command: 'read' }, location.origin);
window.addEventListener('message', (e) => e.data?.source === 'acm-test-result' && console.log(e.data));
```

Commands: `ping`, `permissions`, `read`, `exports`, `zip`, `handoff`, `composer`, `composer-append`, `locate`, `library`, `prompts`, `migration`, `print`, `project-sync`, `memory-context`, `reload`. They return structural reports only (counts, roles, sizes, error reasons), never conversation text; `zip` builds the archive in memory without saving it, `library` removes the test record again.

## Layout

```
manifest.json            MV3, optional host access per platform
sidepanel.html           UI shell
src/background.js        side panel, right-click menu, 2.x migration, memory and test messages
src/platforms/*.js       one adapter per platform: URL matching, fetchRaw (runs in the page), normalize (pure)
src/core/model.js        unified Conversation / Message model
src/core/reader.js       API-first read with page fallback and a 90 s cache
src/core/export.js       Markdown, safe HTML, JSON
src/core/handoff.js      continue-in prompt and library context block
src/core/search.js       chunking and scoring (pure)
src/core/library.js      IndexedDB storage, backup/restore
src/page/page-kit.js     injected helper: DOM → markdown, scroll sweep, composer insertion
src/core/prompts.js      prompt library
src/core/site-*.js       web page readers and page → chat jobs
src/core/deliver.js      put text or an image into a (new) chat
src/core/migrate-v2.js   2.x data migration
src/ui/                  side panel, print page, uk/en strings
```

Adding a platform means adding one adapter file with `matches`, `conversationIdFromUrl`, `fetchRaw`, `normalize`, `dom` and `composerSelectors`, plus a fixture test in `tests/v3/platforms.test.mjs`.

## Tests

```bash
node --test tests/v3/*.test.mjs
```

## Known limits

- Grok long-thread and branch verification (only short chats were available).
- Claude project memory is not enabled.
- YouTube subtitles come from YouTube's transcript panel; caption files are empty without the player's token (October 2026).
