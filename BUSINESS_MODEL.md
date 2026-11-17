# GoodComments — business model and launch plan

## Model today
- **Free and open source (MIT).** No account, no analytics; comments live on the user's Mac.
- **Growth comes from distribution, not sales:** downloads, GitHub stars and word of mouth.
- **Possible paid options later (ideas, not commitments):** a hosted sync/inbox for teams (the cloud mode already exists in the code: Turso + token auth), or a signed "pro" build with team features. Revisit once there are real users asking for them.

## Who it's for
Freelancers, agencies and designers who get feedback from many places (email, WhatsApp, meetings, Figma) and use AI coding agents (Claude Code, Cursor, Codex) to fix it.

**The one-liner:** *your AI agents fix client feedback, and you check it off.*
"A feedback tracker" is a crowded category; agents fixing the feedback while you approve it is not.

## 1. Remove install friction first
Today people need Node 22 and Xcode's tools and build the app themselves. Most won't.
- [ ] **Downloadable app:** join the Apple Developer Program ($99/year) to sign and notarize, and attach a ready-made `GoodComments.dmg` to each GitHub release. Without notarization macOS warns that the app is unsafe.
- [x] **Homebrew tap:** `brew install sdezubiria/goodcomments/goodcomments` (builds from source; tap repo `sdezubiria/homebrew-goodcomments`). Bump `url`/`sha256` in the formula for each release.
- [ ] **Homebrew cask:** once the app is notarized, a cask that installs the prebuilt `.dmg`.
- [ ] **Bundle the server:** ship Node inside the app so the download is the only requirement.
- [ ] **Turn on GitHub Pages** (Settings → Pages → `main` / `docs`) so the website is public.

## 2. Make a 15–30 second video
A client email becomes a comment → the agent fixes it → the card falls to "To check" → you approve it onto the monkey pile. Tendedero's launch post reached about a million views largely from one short clip; the falling monkeys are the shareable moment.

## 3. Launch in a few places within one week
- [ ] **X / Bluesky / LinkedIn:** the video, one line, the GitHub link. LinkedIn reaches agencies and designers.
- [ ] **Hacker News — Show HN:** *"GoodComments – client feedback that your AI agents fix and you check off"*. Weekday morning, US time; stay to answer comments.
- [ ] **Reddit:** r/ClaudeAI, r/macapps, r/SideProject, r/webdev. Show the workflow, don't pitch.
- [ ] **MCP directories:** the official MCP registry, Smithery, mcp.so, and a pull request to awesome-mcp-servers. That's where people looking for agent tools search.
- [ ] **Product Hunt:** once the downloadable app exists.

## 4. Write one practical post
"How I track client feedback with Claude Code", on a personal blog or dev.to, linking the repo.

## 5. Make it easy to keep growing
- [x] README: the GIF first, a one-line install, then screenshots.
- [ ] GitHub topics: `mcp`, `claude-code`, `macos`, `feedback`, `ai-agents`.
- [ ] A few "good first issue" labels to invite contributors.
- [ ] Watch GitHub release downloads and traffic insights (there are no analytics in the app; that's a feature to mention).

## What to measure
| Signal | Where |
|---|---|
| Downloads | GitHub release asset counts, Homebrew analytics |
| Interest | GitHub stars, traffic (views, referrers) |
| Real use | Issues and feature requests, mentions on X / Reddit / HN |
