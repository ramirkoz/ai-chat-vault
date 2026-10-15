# AI Chat Vault

Privacy-first Chrome extension for ChatGPT, Claude, Gemini and Grok: export chats (with their files), keep them in one searchable local library, continue a conversation in another assistant, ChatGPT project memory, a prompt library, and web page → chat tools. No server, no telemetry.

Formerly **GPT Project & Memory Tools** (2.x). Chrome Web Store item: `ingagbhapppiiiccljbhiledobnmhhfb`.

## Current release

**3.0.0** — see [RELEASE_NOTES.md](RELEASE_NOTES.md) and [CHANGELOG.md](CHANGELOG.md).

| Folder | What |
|---|---|
| `extension-v3/` | AI Chat Vault 3.x — the current extension ([details](extension-v3/README.md)) |
| `extension/` | GPT Project & Memory Tools 2.33 — legacy, ChatGPT only |
| `tests/v3/` | tests of 3.x (`node --test tests/v3/*.test.mjs`) |

## Install from source

1. Download `AI-Chat-Vault-3.0.0.zip` from the GitHub release and unpack it (or clone the repository).
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → the unpacked folder (or `extension-v3`).
4. Click the toolbar icon: the side panel opens.

## Privacy

Chats, prompts and the library are stored only in this browser profile; exports are files the user downloads. See [PRIVACY.md](PRIVACY.md).

## License

GPL-2.0-or-later.
