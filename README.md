# GPT Project & Memory Tools

Privacy-first Chrome extension for local ChatGPT Project memory, conversation export, reusable prompts, and attachment handling.

## Current release

**2.33.0** — fixes conversation reading on the September 2026 ChatGPT UI (previously only one "message" was found).

Chrome Web Store extension ID: `ingagbhapppiiiccljbhiledobnmhhfb`

## Main functions

- Automatic local memory for ChatGPT Projects.
- Local synchronization of project conversations into extension-owned browser storage.
- Context retrieval from earlier project chats for a new project conversation.
- Conversation export with available attachments.
- Large-file export support, including tested video and presentation attachments.
- Content deduplication and filename preservation inside portable archives.
- Honest reporting of expired or unavailable legacy attachments in `MISSING_FILES.txt`.
- Local prompt library, saved-chat workspace, search, folders, tags, notes, and backups.
- No developer telemetry or remote executable code.

## How the conversation is read (2.33.0)

1. **ChatGPT conversation API** in the user's own session (`/backend-api/conversation/{id}`), active branch only, grouped into user/assistant turns like the UI. Tool calls, tool output and hidden reasoning are not exported as text.
2. **Page fallback** when the API is unavailable (for example HTTP 429): the visible thread is swept top to bottom and read from `[data-chatgpt-search-unit-key]` units. The side panel shows a warning in this case.
3. **Legacy page reader** for accounts that still receive the pre-September 2026 markup.

## 2.33.0 test status

- Reader regression test (`tests/thread-reader.test.mjs`): PASS; fails on 2.32.1 as expected.
- JavaScript syntax of all extension scripts: PASS (CI workflow `validate-thread-reader.yml`).
- Live check on chatgpt.com, 2026-10-13, a real agentic project conversation (717 API nodes, 310 user/assistant API messages):
  - 2.32.1 reader: **1** message (whole page text).
  - 2.33.0 API reader: **18** turns (9 user / 9 assistant), no leftover citation markers, attachment and `sandbox:` file links preserved.
  - 2.33.0 page fallback without scrolling: 8 mounted messages in correct order; hidden cached threads ignored.
- Not yet verified live: page fallback scroll sweep, Full ZIP with attachments, message navigation, automatic memory injection. See `docs/GPT-Project-Memory-Tools-2.33.0-TEST-REPORT.md`.

## Install from source

1. Download the release source ZIP or clone the repository.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Choose **Load unpacked**.
5. Select the `extension` folder.

## Privacy

Project memory and saved workspace data are stored locally in the browser profile. Exported archives are created locally. The extension does not operate a developer server for user content.

## License

GPL-2.0-or-later.
