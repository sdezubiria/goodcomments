# GoodComments

Feedback tracker for all your projects, hung on a line at the right edge of your screen.
Every comment goes **open → fixed → done**: agents (or you) fix, you check and approve.

No dependencies: Node ≥ 22.13 (built-in SQLite) and, for the edge panel, Xcode.

## Install (macOS)
```bash
brew install sdezubiria/goodcomments/goodcomments
```
or the one-line installer:
```bash
curl -fsSL https://raw.githubusercontent.com/sdezubiria/goodcomments/main/install.sh | sh
```
Homebrew installs `gc`, builds the menu bar app (open it with `open "$(brew --prefix goodcomments)/libexec/mac/build/GoodComments.app"`) and adds a `brew services` entry for the server. Releases: [GitHub releases](https://github.com/sdezubiria/goodcomments/releases).

Downloads GoodComments into `~/.goodcomments/app`, adds `gc` to `~/.local/bin`, builds the menu bar app into `~/Applications` and registers the MCP server with Claude Code if it's installed. Run it again to update. Needs Node.js 22.13+ and Apple's Command Line Tools. The website lives in [`docs/`](docs/index.html).

## Run from a clone

```bash
npm start                  # server + board at http://127.0.0.1:4477
npm link                   # puts `gc` on your PATH
npm run mac                # builds mac/build/GoodComments.app
open mac/build/GoodComments.app
```

The Mac app lives in the menu bar (speech-bubble icon). Rest the pointer on the right edge of the screen and the column slides in; ⌃⌥C toggles it. The 📌 button in its header keeps it open, and — minimizes it (a kept-open panel leaves a sliver at the edge; hover it to bring it back). Drag the panel's left edge to resize it. It starts the server for you if needed.

## The board
Every state lives on one column: comments hang from monkeys on a trunk (open), drop to "To check" when fixed, and fall onto the pile at the bottom when you approve them. Drag and throw the monkeys on the pile; poke the ones on the trunk.

## Cleaning the pile
Click **🧹 Clean up** on the pile (or `gc clean`) to archive the done comments: they leave the board but stay in the database. ⌘Z (or `gc restore <ids>`) brings them back; `gc list -s done --archived` shows them.

## Projects
```bash
cd ~/Code/my-repo && gc project add "My repo" --path .
```
Or use **+ Project** in the column (double-click a chip to edit). With a path set, agents and `gc` inside that folder pick the project automatically.

## Screenshots and files
- **Take one and draw on it:** press ⌃⌥S (or the camera button), pick an area of the screen, then mark it up with pen, arrow, box, highlighter or text and attach it. Click any pending screenshot to draw on it too.
- **Paste, drop or attach:** ⌘V, drag files anywhere onto the column (dragging to the screen edge opens it), or use the paperclip. Images, PDFs and documents (Word, Excel, text, zip…) are welcome; web pages, SVGs and scripts aren't.
- **From the terminal:** `gc add "text" -f shot.png` or `gc attach 12 shot.png spec.docx`. Agents get images from `get_comment`.
- Files live in the database (8 MB max each), so they move to the cloud with it. The first capture asks for macOS Screen Recording permission.

## Inbox: comments from email, Slack, WhatsApp, Shortcuts
Start the server with a secret key: `GOODCOMMENTS_INBOX_KEY=<secret> npm start`. Then anything can POST to
`/api/inbox?key=<secret>` (optional `&project=<id>&source=<name>`):

| sender | how |
|---|---|
| Script / Shortcut | plain text or JSON `{ "text": "...", "project": "acme" }` |
| Email (Postmark, Mailgun, …) | point the inbound webhook at the URL; subject + body become the comment, quoted replies are dropped, attachments kept |
| Slack | create a slash command (e.g. `/gc`) with the URL as its Request URL: `/gc #acme the logo is blurry` |
| WhatsApp (iPhone/Mac) | a Shortcut on the Share Sheet: *Get text from input* → *Get contents of URL* (POST, text body) |

Start the text with `#project` or `[Project]` to file it; an unknown tag still saves the comment, without a project.
Email, Slack and your phone can only reach the inbox once the server is hosted (below).

## Agents
See [AGENTS.md](AGENTS.md) (also served at `/agents.md`). Register the MCP server once:
```bash
claude mcp add goodcomments -s user -- node /path/to/GoodComments/bin/gc.js mcp
```
Agents can list, add, note and mark comments **fixed**; only you mark them **done**.

## Layout
| path | what |
|---|---|
| `server/db.js` | all queries (projects, comments, history, attachments) |
| `server/sql.js` | storage backends: local SQLite at `~/.goodcomments/goodcomments.db` (`GOODCOMMENTS_DB`) or Turso/libSQL |
| `server/inbox.js` | turns webhook payloads (email, Slack, text) into comments |
| `server/index.js` | JSON API, live updates (SSE), serves the web column |
| `server/client.js` | HTTP client used by the CLI and MCP (auto-starts the local server) |
| `server/mcp.js` | MCP server over stdio |
| `bin/gc.js` | CLI |
| `web/` | the column UI (vanilla HTML/CSS/JS) |
| `mac/` | Swift/AppKit edge panel hosting the column |

## Cloud mode
CLI, MCP and the web column only talk to the HTTP API; storage is swappable in `server/sql.js`.
1. **Database:** create a [Turso](https://turso.tech) database and set `GOODCOMMENTS_LIBSQL_URL=libsql://…turso.io` and `GOODCOMMENTS_LIBSQL_TOKEN=…`. (Or keep SQLite on a mounted volume at `/data`.)
2. **Server:** deploy the `Dockerfile` (Fly.io, Railway, Render…) with `GOODCOMMENTS_TOKEN=<secret>` (required — the server refuses to listen publicly without it) and optionally `GOODCOMMENTS_INBOX_KEY`. It reads `PORT` if the host sets one.
3. **Clients:** `export GOODCOMMENTS_URL=https://… GOODCOMMENTS_TOKEN=…` for `gc` and the MCP server. The web column asks for the token once and remembers it.

The Mac edge panel still opens the local server; point it elsewhere by editing `base` in `mac/Sources/GoodCommentsEdge/main.swift`.

## Roadmap and launch
See [BUSINESS_MODEL.md](BUSINESS_MODEL.md) for how GoodComments is meant to grow: install friction to remove, launch channels and what to measure.
