# AI Chat Vault 3.0.0

New name and a rewrite of GPT Project & Memory Tools 2.x. Same Chrome Web Store item (`ingagbhapppiiiccljbhiledobnmhhfb`), so updating keeps the user's 2.x data.

## What is new

- **Four assistants:** ChatGPT, Claude, Gemini and Grok — read, export, save, search.
- **Continue in another assistant:** the selected messages are put into a new chat at any of the other three.
- **One library** for chats from every assistant, with folders, tags, notes, full-text search, bulk ZIP export, backup/restore.
- **ZIP with files** for all four platforms; exports over ~300 MB are split into parts.
- **Side panel** instead of the popup; the right-click menu sends web page content to a chat.
- Interface in Ukrainian (Ukrainian browsers) and English (all others).

## Kept from 2.x

Automatic ChatGPT project memory, prompt library, Markdown/HTML/PDF/JSON export, message search and "show in chat", selected text / page text / screenshot / YouTube subtitles to a chat.

## Migration from 2.x

On update the extension moves 2.x saved chats (with folders, tags, notes and project binding), prompts and the project-memory switch into 3.0, and removes the old memory script.

## Verified live (15 October 2026)

| | ChatGPT | Claude | Gemini | Grok |
|---|---|---|---|---|
| Read through the site API | ✅ | ✅ | ✅ | ✅ |
| Export MD / HTML / JSON | ✅ | ✅ | ✅ | ✅ |
| ZIP with files | ✅ | ✅ | ✅ | ✅ |
| Continue in / insert into chat input | ✅ | ✅ | ✅ | ✅ |
| Show in chat | ✅ | ✅ | ✅ | ✅ |
| Project memory (sync + first-message injection) | ✅ | — | — | — |

Web page tools (selection, page text, screenshot, YouTube transcript, right-click menu), prompts, library folders/tags and PDF were checked by hand in Chrome.

Automated tests: 36 (`node --test tests/v3/*.test.mjs`), run in CI on every push.

## Known limits

- YouTube no longer serves caption files without its player token; subtitles are read from YouTube's own "Transcript" panel, which the extension opens.
- Claude project memory is not enabled yet.
- Message ids are not exposed by Claude and Gemini pages, so "Show in chat" finds those messages by their text.
