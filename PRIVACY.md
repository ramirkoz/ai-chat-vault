# Privacy Policy — AI Chat Vault

**Effective date:** 15 October 2026
**Applies to:** AI Chat Vault 3.0.0 and later (Chrome Web Store item `ingagbhapppiiiccljbhiledobnmhhfb`, previously published as "GPT Project & Memory Tools", "ChatExtra Toolkit" and "Thread to Markdown for ChatGPT").

## Summary

AI Chat Vault reads, exports, saves and continues conversations from ChatGPT, Claude, Gemini and Grok, keeps a local prompt library, and can put user-chosen web page content into a new chat. Everything is processed inside the user's browser. The extension has no server: it does not send conversation content, prompts, saved chats, page content, screenshots, transcripts, URLs, account information or files to the developer or to any third party. There is no analytics, telemetry, advertising, tracking or remote code.

## What the extension reads, and when

| Data | When | Where it goes |
|---|---|---|
| The open conversation in ChatGPT, Claude, Gemini or Grok | When the user opens the side panel on that conversation, exports, copies, saves or continues it | Shown in the side panel; written only to files the user downloads or to the local library |
| Files of that conversation (uploads, images, created files) | Only when the user chooses **ZIP with files** | Into the ZIP the user downloads |
| Chats of a ChatGPT Project | Only when the user turns on **Automatic project memory**, then when a chat of that project is opened | Local library in the browser |
| Selected text, page text, visible-area screenshot, YouTube subtitles of the active tab | Only after the user clicks the action in the side panel or the right-click menu | Into the input of a new chat that the user chooses; never sent automatically |
| Prompts the user writes | When the user saves them | Local browser storage |

The extension reads the chat sites with the user's own signed-in session, the same way the site itself does (for example ChatGPT's conversation endpoint or Claude's conversation endpoint). It does not read other sites, cookies, passwords, browsing history or other tabs.

## Local storage

- **Library** (saved chats, project memory, folders, tags, notes): the extension's IndexedDB in the current browser profile.
- **Prompts and settings:** `chrome.storage.local` of the extension.
- **Temporary data** (a prepared page text or screenshot waiting for the user to pick an assistant, a print job for PDF export): `chrome.storage.session`, cleared when the browser closes or after use.

The user can delete saved chats and prompts in the side panel, export them as a backup file, or remove everything by uninstalling the extension. Data is not synchronised between devices.

## Automatic project memory

Off by default. When the user turns it on, opening a chat in a ChatGPT Project copies that project's chats into the local library (only new or changed chats). When the user sends the first message of a new chat in that project, excerpts from earlier project chats are inserted in front of the message as a clearly marked `[PROJECT MEMORY: …]` block. The message is sent to ChatGPT by the user's own action, as part of the user's ChatGPT conversation. Nothing is added to ChatGPT's Project files.

## Continuing a chat in another assistant

When the user clicks **Continue in …**, the selected messages are put into the input of a new chat at the chosen assistant (ChatGPT, Claude, Gemini or Grok). The text is not sent until the user sends it. That assistant then processes it under its own privacy policy.

## Test mode

Off by default and switches itself off after 60 minutes. While on, a script on the four chat sites accepts test commands from the page and returns structural reports only (message counts, roles, sizes, error reasons) — never conversation text.

## Permissions

- **activeTab** — read the tab where the user opened the extension (page text, selection, visible screenshot).
- **scripting** — run the reader in the chat page or in the active tab after a user action.
- **sidePanel** — show the user interface next to the page.
- **contextMenus** — the right-click actions for sending page content to a chat.
- **downloads** — save exports, ZIP archives and backups.
- **storage** — prompts, settings and temporary data.
- **Optional host access** to `chatgpt.com`, `chat.openai.com`, `claude.ai`, `gemini.google.com`, `*.googleusercontent.com` (Gemini images) and `grok.com` — requested separately, only when the user first uses the extension on that site.

## Limited use

Information obtained through these permissions is used only to provide the features described above. It is not transferred to the developer or third parties, not used for advertising, credit-worthiness or lending, not sold, and not read by humans.

## Changes

Changes to this policy are published in this file in the public repository, with the date at the top.

## Contact

**kozyriev@uafree.org** · https://github.com/ramirkoz/thread-to-markdown-for-chatgpt/issues

## Trademarks

AI Chat Vault is an independent extension and is not affiliated with, endorsed or sponsored by OpenAI, Anthropic, Google or xAI. ChatGPT, Claude, Gemini and Grok are trademarks of their owners.
