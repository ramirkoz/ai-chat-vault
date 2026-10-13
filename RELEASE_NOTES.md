# GPT Project & Memory Tools 2.33.0

Fix release for the September 2026 ChatGPT UI.

## Problem

After ChatGPT's UI update the side panel listed a single "message" containing the whole page text, and every export format, Full ZIP attachment binding, Workspace snapshots and the project-memory agent were affected. The legacy `article` / `[data-message-author-role]` markup no longer exists and the thread is virtualized, so only a few turns are present in the page at any time.

## Fix

- The conversation is read from ChatGPT's own conversation API in the user's session and grouped into user/assistant turns like the UI.
- A new-UI page reader with a scroll sweep and the legacy page reader remain as fallbacks; the side panel warns when the fallback was used.
- Full ZIP binds attachments to turns by API message id.
- Message navigation, project-memory new-chat detection and composer detection were updated for the new markup.

## Verified

- Synthetic regression test: PASS (fails on 2.32.1).
- Live API reader on a real 717-node agentic conversation: 18 turns instead of 1.
- Live page fallback (no scroll): 8 mounted messages, correct order.

## Still to verify before Chrome Web Store upload

- Full ZIP export with attachments on the new UI.
- Page fallback scroll sweep on a long conversation in a visible tab.
- Message navigation from the side panel.
- Automatic project-memory injection on a new project chat.

## Chrome Web Store

Existing extension ID: `ingagbhapppiiiccljbhiledobnmhhfb`.
