# Hosted GoodComments. Needs GOODCOMMENTS_TOKEN; use Turso for storage
# (GOODCOMMENTS_LIBSQL_URL + GOODCOMMENTS_LIBSQL_TOKEN) or mount a volume at /data.
FROM node:24-alpine
WORKDIR /app
COPY package.json AGENTS.md ./
COPY server ./server
COPY web ./web
COPY bin ./bin
ENV GOODCOMMENTS_HOST=0.0.0.0 GOODCOMMENTS_DB=/data/goodcomments.db NODE_ENV=production
EXPOSE 4477
CMD ["node", "--no-warnings", "server/index.js"]
