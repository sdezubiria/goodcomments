# GoodComments — guide for agents

GoodComments tracks feedback on projects. Each comment moves through three states:

| state   | meaning                                   | who moves it there      |
|---------|-------------------------------------------|-------------------------|
| `open`  | someone asked for a change                | anyone                  |
| `fixed` | the change is made, waiting to be checked | you (the agent), with a note |
| `done`  | the owner checked it                      | **only the owner**      |

## Rules
1. Before working on a repo, list its open comments.
2. When you finish a change for a comment, mark it **fixed** with a note: what you changed and where (files, pages, URLs), so the owner can check it in seconds.
3. Never mark a comment `done`. Never delete comments.
4. If a comment is unclear or blocked, add a note instead of guessing.
5. If you notice a problem you won't fix now, add it as a new comment (`source: Agent`).

The project is picked automatically from the folder you're in (each project can have a repo path). Pass a project id to override it.

## MCP (preferred)
Tools: `list_projects`, `list_comments`, `get_comment` (returns attached screenshots as images), `add_comment`, `mark_fixed`, `add_note`.

```bash
claude mcp add goodcomments -s user -- node /path/to/GoodComments/bin/gc.js mcp
```

## CLI
```bash
gc                         # open + fixed comments for this folder's project
gc list -s open --json     # machine-readable
gc show 12
gc fix 12 "Resized hero image in header.php; checked on mobile"
gc note 12 "Need the new logo file before I can fix this"
gc add "Footer link 404s on /contacto" -s Agent -l /contacto -f shot.png
gc attach 12 before.png after.png   # show what you changed
```
Set `GOODCOMMENTS_ACTOR=claude` (or your name) so changes show who made them.

## HTTP API (base `http://127.0.0.1:4477`)
- `GET  /api/projects` · `GET /api/projects/resolve?path=<dir>`
- `GET  /api/comments?project=<id>&status=open|fixed|done|all&q=<text>`
- `GET  /api/comments/:id` (includes history)
- `POST /api/comments` `{ body, project?, source?, location? }`
- `POST /api/comments/:id/status` `{ status: "fixed", note }`
- `POST /api/comments/:id/notes` `{ note }`
- `POST /api/comments/:id/attachments` raw file body, `content-type: image/png` (or jpeg/gif/webp/heic/pdf), `x-filename` header
- `GET  /api/attachments/:id`

Send `content-type: application/json` and an `x-actor` header with your name.
