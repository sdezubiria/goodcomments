# GoodComments Cloud — plan

Goal: your comments are up to date on every device, and people or teams who want that pay a small monthly price. Same idea as Obsidian: the app is free and local, syncing is paid.

## Technical approach (simplest)

**One hosted server is the source of truth.** Today every Mac runs its own server and database. With sync, an account lives on one hosted server and every device (Mac panel, `gc`, MCP, phone) points at it with `GOODCOMMENTS_URL` and a token. No sync engine, no merge conflicts.

Most of this is already in place: clients only talk to the HTTP API, the server refuses to listen publicly without `GOODCOMMENTS_TOKEN`, Turso storage is supported, and there's a `Dockerfile`.

| Piece | Choice | Status |
|---|---|---|
| Hosting | Fly.io / Railway / Render from the `Dockerfile` | Done |
| Database | Turso (hosted SQLite) or Postgres | Turso adapter done |
| Accounts | Email login link + one API token per device or agent | To build |
| Per-customer data | `workspace_id` on projects and comments; every query filtered by it | To build (small) |
| Screenshots | Object storage (Cloudflare R2) instead of the database | To build |
| Payments | Stripe Checkout + billing portal; Stripe webhook turns sync on/off | To build |
| Phone | Installable web column (PWA) | Small |
| Hosted MCP | Agents connect to the server URL with a token | To build — key selling point |

**Offline:** keep a read-only copy on each device and queue changes made offline; "last change wins" is enough because comments are rarely edited by two people at once.

**Not now:**
- True two-way local sync (Turso embedded replicas, CRDTs): much more complex for little gain.
- End-to-end encryption: agents must read comments. Offer encryption at rest and a clear privacy policy.

## Business model

| Plan | Price | Includes |
|---|---|---|
| **Local** | Free forever | Everything on one Mac, MCP server, CLI |
| **Sync** | ~$4/mo yearly, $5 monthly | All devices, phone capture, email/Slack/WhatsApp inbox, hosted MCP for cloud agents, ~5–10 GB screenshots |
| **Team** | ~$6–8 per person/mo | Shared workspaces, assign comments, roles, activity history |

- **Reference price:** Obsidian Sync is about $4–5/month.
- **Fees:** Stripe (~2.9% + $0.30) takes ~10% of $4 — push yearly billing.
- **Costs:** hosting ~$5–20/mo plus Turso's free tier and cheap R2 storage; break-even at a handful of subscribers.
- **Open source:** the repo is MIT, so anyone can self-host. That's fine — you sell the convenience (hosting, phone, inbox, teams).
- **Strongest selling points:** capturing comments from a phone or a client's email, and cloud agents working from your comments.

## Build order

1. Accounts and `workspace_id` on the data.
2. Tokens, plus "Connect to cloud" in the Mac app and `gc`.
3. Hosting, Turso and R2.
4. Stripe Checkout, billing portal and the paid/unpaid switch.
5. Phone-friendly web column and hosted MCP endpoint.
6. Team features.

Steps 1–4: roughly one to two weeks of focused work.
