## 3.0.0 — AI Chat Vault

- Renamed to **AI Chat Vault**; rewritten as a side-panel extension (`extension-v3/`).
- Support for ChatGPT, Claude, Gemini and Grok through each site's own conversation API, with a page-reading fallback.
- Continue a conversation in another assistant; insert library search results as context into any chat.
- One local library for all assistants: folders, tags, notes, folder filter, full-text search, bulk ZIP export, backup/restore.
- ZIP with files for all four platforms: SHA-256 deduplication, retries, `MISSING_FILES.txt`, split into ~300 MB parts.
- Ported from 2.x: automatic ChatGPT project memory, prompt library, PDF export, message search and "show in chat", selected text / page text / screenshot / YouTube subtitles to a chat (now also from the right-click menu and to any assistant).
- YouTube: reads the 2026 transcript panel (caption files are empty without the player's token).
- Page text skips hidden menus (e.g. Wikipedia's language list).
- Migration of 2.x saved chats, prompts and the project-memory switch on update.
- Ukrainian interface for Ukrainian browsers, English for all others.
- Opt-in test mode for automated testing (structural reports only, 60 minutes).
- 36 automated tests in CI.

## 2.33.0

- Fixed the main export regression caused by the September 2026 ChatGPT UI: the reader found only one "message" (the whole page text) because the legacy `article` / `[data-message-author-role]` markup is gone and the thread is now virtualized.
- The open conversation is now read from ChatGPT's own conversation API in the user's session (`/backend-api/conversation/{id}`), following the active branch from `current_node`. Abandoned edit/regenerate branches are not exported.
- Messages are grouped into turns exactly like the UI: one user message, then one assistant answer. Tool calls, tool output, hidden reasoning and context messages are not exported as text, but their message ids stay bound to the turn.
- Inline citation markers are replaced by their markdown source links; canvas documents created in a turn are exported as sections; user attachments are listed by name.
- Fallbacks when the API is unavailable (for example HTTP 429): the new-UI DOM reader (`[data-chatgpt-search-unit-key]` units inside the visible thread, with a top-to-bottom scroll sweep), then the legacy DOM reader. Hidden copies of previously opened chats are ignored. The side panel now warns when the page fallback was used.
- The silent "whole page as one message" fallback was removed; a failed read now reports an explicit error.
- Conversation payloads are cached for 90 seconds so listing and exporting the same chat cost one API request; a single 429 is retried after `Retry-After`.
- Full ZIP: attachment hints are re-bound to transcript turns by API message id, so files land next to the right turn and files from other branches are dropped.
- Message navigation finds the target by message id in the new UI and ignores hidden cached threads.
- Automatic project memory: new-chat detection works again (it previously treated every project chat as new), and tool-call messages and citation markers are no longer stored in project memory.
- Composer detection updated for the new `[contenteditable][data-composer-markdown]` editor in memory insertion and handoffs; memory insertion uses `insertText` so the editor state updates.
- Added `tests/thread-reader.test.mjs` and a CI workflow that checks syntax of every extension script and runs the reader regression test.

## 2.32.0

- Final hardening release for Full ZIP export.
- Preserves the proven 2.31.0 path that captured 9/9 current mixed attachments, including 104.8 MB MP4 and 17.9 MB PPTX files.
- Keeps exact-content SHA-256 deduplication and stable attachment labels.
- Adds a bounded 18-second discovery window for legacy cards that no longer expose file identity; full large-file/video budgets are restored immediately when a valid identity is recovered.
- Classifies unrecoverable legacy cards as `metadata-unavailable` or `expired-or-access-denied` instead of repeatedly cycling through long retries.
- `MISSING_FILES.txt` now includes availability status and whether retrying is useful.
- Does not guess attachment identities: expired ChatGPT files remain honestly listed as missing rather than substituting wrong bytes.

## 2.31.0

- Recover unresolved attachment cards from browser resource entries when the signed URL exposes the exact same filename and only one resource identity matches.
- Keep ambiguous same-name resources unresolved rather than risking the wrong bytes.
- Reject obvious domain fragments such as `www.postman.c` when they have no real file identity.
- Preserve 2.30.0 large-file timeouts, content dedupe and label normalization.

# 2.30.0

- Fixes the active Full ZIP worker that still used hidden 4.5-second descriptor timeouts.
- Stops unresolved cards from refetching the full conversation once per file.
- Uses longer sandbox descriptor time only where a real sandbox path exists, while stale file-id routes fail faster.
- Gives large archives/installers up to 90 seconds for the actual byte download after a signed URL is obtained.
- Keeps the 192 MB normal per-file archive limit and existing label/content deduplication fixes.

# 2.29.0

- Fixes the live Full ZIP downloader still using the old 12-second per-file budget despite the 2.28.0 recovery changes.
- Raises the active attachment request timeout to 30 seconds and the per-file recovery budget to 120 seconds.
- Uses a 300-second budget for video attachments.
- Raises the normal per-file archive limit from 48 MB to 192 MB for larger application/source ZIPs and EXE artifacts.
- Downloads attachment candidates serially to avoid two large ChatGPT sandbox downloads timing out each other.
- Keeps the existing file-route order, content deduplication, stable labels, fail-open archive behavior, and 640 MB total asset budget.
- No interactive file-card clicks or background download loops are introduced.

# 2.28.0

- Keeps the 2.27.0 cross-message SHA-256 deduplication and stable attachment labels.
- Preserves the 2.26.0 attachment route order, but skips redundant full-conversation enrichment when an exact sandbox path is already known.
- Raises the normal per-file recovery budget from 14s to 22s and request timeout from 4.5s to 6s for slower ChatGPT attachment endpoints.
- Raises the video recovery budget to 120s.
- No new interactive download clicks, blobs/chunks, or background network loops are introduced.

# Changelog

## 2.27.0 - 2026-08-24

- Fixed cross-message attachment deduplication: byte-identical files are now SHA-256 matched across the full selected export, not only inside one message.
- Keeps every message-level attachment reference while storing one canonical binary in the ZIP, so duplicate files no longer appear as `-2`, `-3`, and similar copies.
- Fixed contaminated attachment labels from ChatGPT file cards: labels containing a different filename or UI text such as “Document / Open file” now fall back to the real captured filename.
- Added diagnostics for deduplicated binary storage and preserved attachment references.
- Preserved the 2.26.0 large-video limits, exact file identity matching, progress UI, cancellation, fail-open ZIP behavior, and Project memory features.

## 2.26.0 - 2026-08-23

- Removed the accidental 48 MB ceiling for video attachments: MP4/MOV/WebM/M4V/AVI/MKV can now use up to 512 MB per file while non-video files keep the conservative 48 MB limit.
- Raised the full archive asset budget from 192 MB to 640 MB so one legitimate large video does not invalidate an otherwise successful mixed export.
- Increased only the video transfer budget to 90 seconds and the active video request window to 60 seconds; normal document/image behavior remains unchanged.
- Preserved exact `file_id` resource matching, XLSX duplicate-name handling, generated-file capture, PDF deduplication, progress UI, cancellation and fail-open ZIP behavior.

## 2.25.0 - 2026-08-23

- Re-bound Resource Timing URLs to attachments only when the exact `file_id` matches the message-bound file card.
- Added live signed-resource replay before generic descriptor routes, targeting MP4/video attachments whose current playback URL is valid while later `/files/download` URLs return 403.
- Added video-aware binary requests with `Range: bytes=0-`, media `Accept` headers, a longer transfer timeout, and `Content-Range` size validation.
- Preserved the 2.24.0 filename alias coalescing, XLSX `(2)` handling, generated-file capture, and duplicate suppression unchanged.

## 2.24.0

- Fixed video descriptor selection: when ChatGPT returns several signed URLs, the exporter now ranks and tries multiple candidates instead of trusting the first generic content URL, which can be a poster/preview image.
- Prioritized original/download file routes before inline preview routes for MP4/MOV/WebM/M4V attachments.
- Increased the per-file budget only for video attachments from 14s to 26s; all non-video budgets and queue behavior remain unchanged.
- Preserved the 2.23.0 filename alias coalescing, XLSX `(2)` handling, PDF content deduplication, progress UI, cancellation, fail-open ZIP and Project memory behavior.

## 2.23.0

- Coalesced short filename aliases into the longer same-message file card when the visible label or concrete file identity proves they are the same attachment, fixing `Pryvitannya.mp4` vs `Dniprorudne Pryvitannya.mp4`.
- Accepted explicit HTTPS signed URLs returned by authenticated ChatGPT file descriptors even when the video CDN is outside the normal attachment host pattern; downloaded bytes are still validated before export.
- Expanded MP4/MOV/M4V validation to recognize ISO-BMFF boxes within the first 4 KB instead of requiring `ftyp` at byte 4.
- Added prioritized `inline=true` video variants for project, conversation and generic ChatGPT file routes before the existing descriptor routes.
- Preserved queue=2, per-file budget, progress UI, Cancel, fail-open ZIP, automatic Project memory, duplicate-name handling and content deduplication.

## 2.22.0

- Fixed duplicate browser-style filenames such as `name(2).xlsx`: metadata validation now treats numeric copy suffixes as the same file identity instead of rejecting the correct `file_id`.
- Added the alternate ChatGPT file route `/backend-api/files/{file_id}/download` alongside the existing `/backend-api/files/download/{file_id}` route, with an `inline=true` video fallback for MP4/MOV/M4V.
- Added explicit MP4/MOV/WebM byte validation so video fallback cannot silently save JSON/HTML as a media file.
- Added final same-message content deduplication: exact source-URL duplicates are removed first, then same-size/MIME candidates are SHA-256 checked and the best filename is retained.
- Preserved queue=2, per-file budget, progress UI, Cancel, fail-open ZIP, automatic Project memory and sync behavior.

## 2.21.0

- Replaced the monolithic attachment worker with a modular per-file pipeline.
- Attachment candidates are built in the background from message-bound DOM/React hints, then each file is resolved in its own page-world worker.
- Added per-card DOM/React enrichment so user uploads and generated files can recover their own file_id or sandbox path without leaking identities from neighbouring cards.
- Added metadata filename validation to prevent one signed image URL/file_id from being reused for XLSX, DOCX, PDF, PPTX or other cards.
- Preserved two-file concurrency, per-file time budgets, progress UI, cancellation and fail-open ZIP creation.
- Added conservative alias cleanup for truncated names such as `(eng).pdf` and `Pryvitannya.mp4`.

## 2.20.0
- Make the attachment candidate worker fault-safe: a top-level runtime exception no longer collapses Full ZIP to `0 added / 0 skipped`.
- Record the exact attachment-worker runtime error in `manifest.json` and continue building a partial archive from message-bound hints.
- Materialize per-candidate worker exceptions as skipped files with concrete reasons instead of silently dropping them.
- Add candidate error counters/samples to attachment pipeline diagnostics and a localized recovery progress state.
- Add automatic cleanup for the injected cancel listener if an unexpected worker exception aborts normal cleanup.
- Keep the working 2.15+ downloader, UI, automatic project memory, sync, queue=2, time budgets and Cancel behavior unchanged.

## 2.19.0
- Preserve real message-bound file cards as export candidates even when ChatGPT has not exposed file_id, sandbox path or signed URL yet.
- Promote early DOM/React/API attachment hints into the download pipeline before later enrichment, instead of silently dropping them.
- Allow filename-only user-upload/generated-file cards to reach React/API enrichment and, if still unresolved, report them honestly in MISSING_FILES.txt.
- Add candidate-pipeline diagnostics to manifest.json: raw hints, promoted/unresolved candidates, pre-download candidates and final included/skipped counts.
- Keep the 2.15+ downloader, queue=2, progress/cancel UI, automatic Project memory and sync behavior unchanged.

## 2.18.0
- Scan real file cards across the whole ChatGPT `main` area, not only descendants of a message turn.
- Bind sibling/out-of-turn file cards to the nearest selected message using containment first, then geometry, then document order.
- Apply the same global binding path to generated files, user-upload cards and visible image cards while still requiring a real file ID, sandbox path or ChatGPT asset URL.
- Add attachment-detection diagnostics to `manifest.json` with DOM-card, React-identity, API/conversation and global-binding counts by detector.
- Preserve the working 2.15+ download resolver, queue=2, progress/cancel UI, automatic Project memory and 6/6 sync behavior.

## 2.17.0
- Capture message-bound file identity before transcript preparation so ChatGPT DOM changes cannot erase attachments mid-export.
- Add early MAIN-world deep React scan inside each selected message, including non-interactive user-upload cards.
- Add early structured conversation snapshot for virtualized/off-screen user uploads and assistant tool-generated files.
- Preserve 2.15+ download resolver, safe queue=2, progress UI, cancel, automatic project memory and 6/6 sync behavior.

## 2.16.0
- Added universal message-bound file-card detection for user uploads and assistant output files.
- Reads file identity from compact React props only inside the selected message; no clicks and no global React scan.
- Structured conversation parsing now recognizes file-service/sediment pointers and direct asset URLs.
- Conversation attachment discovery is attempted even when the session endpoint does not expose an access token.
- Preserves 2.15.0 download resolver, deduplication, progress UI, queue=2, cancel, fail-open ZIP, and automatic Project memory.

## 2.15.0
- Added final message-bound attachment de-duplication after generated-file recovery.
- When a real attachment is successfully captured for a message, the synthetic `.bin` fallback for the same file card is removed from the final asset set.
- `manifest.json`, `MISSING_FILES.txt`, final Included/Skipped counters and completion badge now reflect the real recovered files instead of counting the fallback placeholder as missing.
- De-duplication is deliberately narrow: it only suppresses unresolved attachment fallbacks in the same message when the card label/file identity matches a successfully captured attachment.
- Kept the working 2.14.0 download resolver, automatic Project memory, 6/6 sync, two-file queue, progress bar, cancellation and time budgets unchanged.


## 2.14.0

- Fixed generated-file cards whose visible ChatGPT label has no file extension, for example “Завантажити … Portable”.
- Replaced the Cyrillic-unsafe `\b` boundary in generated-download detection with an explicit whitespace/separator boundary.
- Added MAIN-world message-bound card inspection: the interactive control and only its compact ancestors are checked for React file metadata, sandbox paths and file IDs.
- MAIN-world generated-card hints may now create an attachment candidate when the isolated extension world cannot see React expando properties. Creation requires a concrete selected message plus a real file ID, sandbox path or ChatGPT asset URL.
- Ordinary “Завантажити …” prose and external links still do not become attachments without real message-bound file identity.
- Kept automatic Project memory, 6/6 sync UI, export progress, queue=2, time budgets, Cancel and existing 2.13 download routes unchanged.

## 2.13.0

- Restored message-bound detection for ChatGPT-generated files whose real pointer is `sandbox:/mnt/data/...`.
- Sandbox paths are now extracted from the exact selected message DOM before normal URL filtering, so `sandbox:` is no longer discarded as a non-HTTP URL.
- Added bounded, read-only React-prop inspection on the exact interactive file card to recover sandbox paths/file IDs that ChatGPT keeps outside visible attributes. No card clicks or global React-state crawling are used.
- Generated download controls such as “Завантажити …” are recognized only when they are interactive and bound to the selected message; ordinary filename mentions in prose remain ignored.
- MAIN-world attachment hints can now carry message-bound sandbox paths into the isolated-world downloader.
- Tightened file-ID recognition so UI tokens such as `file-download` cannot be mistaken for real ChatGPT file IDs.
- Attachment deduplication now prefers exact sandbox path identity when a file ID is unavailable.
- Kept Project memory, sync UI, progress bar, queue=2, per-file time budget, cancel, fail-open ZIP and 2.12 download routing unchanged.

## 2.12.0

- Fixed Project attachment routing: `file_...` IDs can now use the Project `gizmo_id`; ID punctuation is no longer used to guess ownership.
- `/simple` metadata now carries `is_project`, `is_library_file`, `gizmo_id`, and requested/resolved file IDs into the downloader.
- Added ordered Project → conversation → generic descriptor resolution for the same message-bound file.
- Added authenticated bare Estuary fallback when ChatGPT refuses to mint a signed descriptor.
- Normalized placeholder attachment labels to the real filename once metadata resolves it.
- Kept memory, sync, progress UI, queue=2, per-file time budget, cancel, and fail-open archive behavior unchanged.

## 2.11.0
- Added a message-bound generated-file resolver for explicit `sandbox:/mnt/data/...` attachments using ChatGPT's interpreter download descriptor flow.
- Sandbox recovery requires the exact conversation ID, message ID and safe `/mnt/data/` path; path traversal and non-sandbox paths are rejected.
- Added `chatgpt-project-id` to authenticated same-origin backend requests inside Project chats.
- Download descriptor parsing now accepts nested/current signed URL fields instead of assuming only a top-level `download_url`.
- Generated-file sandbox recovery runs before the generic file-ID resolver, while user-uploaded/project files keep the existing file-ID path.
- Kept the 2-file queue, progress bar, cancellation, fail-open ZIP behavior, automatic Project memory and current UI unchanged.

## 2.10.0
- Rebuilt Full ZIP attachment detection around message-bound identity: message ID/index → structured attachment object → file_id → filename.
- Removed filename-only attachment discovery from normal prose, code blocks and standalone text, preventing false downloads for mentioned `.zip`, `.log`, `.exe`, `.py`, etc.
- Conversation API parsing now inspects structured message metadata/content only and binds file references to the exact selected message; tool-generated file pointers are bound only to the nearest following assistant message.
- Global performance/resource URLs can only enrich an already-known file_id and can no longer create unrelated archive entries.
- Download resolution now asks ChatGPT for the signed download descriptor for the exact file_id, then fetches the returned binary URL; project `gizmo_id` is used as a bounded fallback where applicable.
- Metadata lookup is limited to file IDs already bound to selected messages and can restore original filenames for anonymous file cards.
- Transcript fallback now recognizes only real file links (`sandbox:` or ChatGPT file/download URLs); plain filename mentions never create `MISSING_FILES.txt` entries.
- Kept the 2-file queue, per-file time budget, progress bar, cancellation, fail-open ZIP creation and automatic Project memory UI unchanged.

## 2.9.0
- Project auto-sync now starts immediately after Project ID detection and no longer waits for ChatGPT DOM/streaming to become quiet.
- Side Panel can start automatic synchronization itself, so memory refresh works even if the content script has not reloaded yet.
- Project/chat navigation is detected while the Side Panel stays open and memory follows the active Project automatically.
- Failed/partial automatic attempts no longer trigger the 4-minute success cooldown; cooldown is written only after a completed sync.
- Added an explicit `starting` sync state before authentication/discovery, so the memory block shows activity earlier.
- Current-chat autosave remains DOM-debounced, but it is isolated from whole-project synchronization.
- Full ZIP attachment transport is unchanged from 2.8.0.

## 2.8.0
- Added the Full ZIP progress panel to the ChatGPT side panel, where exports are actually run. The progress view is sticky and includes stage, percent, file counters, elapsed time and Cancel.
- Moved the Automatic memory switch back into the main Local project memory card. Manual Sync remains under Service & manual controls.
- Added live Project-memory synchronization progress with discovering/syncing stages and processed/total, updated, unchanged and failed counters.
- Background Project sync now persists in-progress state as it works, so the UI can show 0/N → N/N instead of only the final result.
- Reduced Workspace status polling to 1.5 seconds while keeping synchronization itself incremental.
- Kept the controlled two-file Full ZIP queue and attachment recovery behavior from 2.6/2.7 unchanged.

## 2.7.0
- Reframed Workspace around zero-click local Project memory: normal use no longer requires Sync, Find or Insert.
- Added silent periodic Project synchronization while ChatGPT Project tabs are open.
- Added incremental synchronization: unchanged conversations are skipped and only new/changed branches are fetched during routine background sync.
- Added non-blocking sync refresh when the first message in a new Project chat requests local memory.
- Automatically enables local memory after update when ChatGPT site access was already granted and the user had no explicit preference.
- Moved manual sync, metadata, library export, backup/restore and manual memory search into a collapsed Service section.
- Kept controlled two-file Full ZIP queue/progress/cancel behavior from 2.6.0.

## 2.6.0
- Added a visible Full ZIP progress bar with elapsed time, current file, saved/missing counters and Cancel.
- Replaced unbounded attachment probing with a controlled two-file queue.
- Added per-request and per-file time budgets so inaccessible ChatGPT files cannot stall the whole archive for minutes.
- Full ZIP is fail-open: missing or timed-out files are recorded and the archive is still created.
- Added pre-download de-duplication and reuse of successful signed URLs.
- Kept Project sync and automatic local memory behavior from 2.5.0.

## 2.5.0
- Reworked Project synchronization to use authenticated ChatGPT read APIs directly, with no temporary tabs or windows.
- Added full-project pagination so hidden conversations are synchronized, not only links currently rendered in the sidebar.
- Added automatic local project-memory retrieval and first-message context injection for new chats inside a ChatGPT Project.
- Simplified Workspace into a compact, single-language interface based on the browser UI language.
- Added a clear project-memory readiness state (for example, 5/5 PASS).
- Reworked Full ZIP attachment recovery to use the current ChatGPT Bearer session and account header.
- Added raw conversation asset_pointer discovery and authenticated two-step file download resolution.
- Added gizmo_id fallback for project-library files and authenticated estuary downloads.
- Tightened service-artifact filtering and retained binary/MIME signature validation.
- Kept all memory and Workspace data local; nothing is added to ChatGPT Project Sources.

## 2.4.0
- Non-interactive attachment recovery and minimized-window Project synchronization candidate.
