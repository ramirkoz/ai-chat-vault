# Chrome Web Store submission — AI Chat Vault 3.0.0

## Package

- Upload `AI-Chat-Vault-3.0.0.zip` from the GitHub release `v3.0.0` (`manifest.json` at the ZIP root, version 3.0.0, Manifest V3).
- Update the **existing item** `ingagbhapppiiiccljbhiledobnmhhfb` (Developer Dashboard → the item → Package → Upload new package). Do not create a new item: only an update keeps the users' 2.x data, which 3.0 migrates.
- Permissions: `activeTab`, `contextMenus`, `scripting`, `downloads`, `storage`, `sidePanel` — none of them shows an install warning. Host access is optional only.

## Store listing tab

- Name and summary come from the package (`AI Chat Vault`).
- Paste the English description from `STORE_LISTING.md`; add the Ukrainian description under the Ukrainian locale.
- Category: Productivity. Language: English (+ Ukrainian).
- Replace the old screenshots (see the list in `STORE_LISTING.md`).
- Support URL and homepage: the GitHub repository.

## Privacy tab

- Single purpose and permission justifications: copy from `STORE_LISTING.md`.
- Remote code: No.
- Data usage: website content, personal communications, user-generated content — handled locally; certify the three "not sold / not transferred / not used for creditworthiness" statements.
- Privacy policy URL: https://github.com/ramirkoz/thread-to-markdown-for-chatgpt/blob/main/PRIVACY.md

## Before pressing "Submit for review"

- Install the exact ZIP in a clean profile, open a ChatGPT chat, export Markdown.
- Check that the description does not use the OpenAI / Anthropic / Google / xAI logos and keeps the "independent" sentence.

Review usually takes from a few hours to a few days. New optional host permissions and a new name can make it longer.
