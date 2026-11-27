# Runs the GoodComments MCP server (stdio) in a container, for directories
# like Glama that check servers automatically. On a Mac, install with
# Homebrew instead: brew install sdezubiria/goodcomments/goodcomments
FROM node:24-slim

WORKDIR /app
COPY package.json AGENTS.md ./
COPY bin ./bin
COPY server ./server
COPY web ./web

# The MCP server starts the local board server on 127.0.0.1 when a tool needs it.
# Its SQLite database lives in the node user's home folder.
USER node
ENV GOODCOMMENTS_ACTOR=agent

ENTRYPOINT ["node", "--no-warnings", "bin/gc.js", "mcp"]
