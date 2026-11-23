FROM oven/bun:1.4.4

WORKDIR /app
COPY room-server.mjs boss.mjs lobby-network.mjs web-assets.mjs ./
COPY page/format.js ./page/format.js
COPY web/ ./web/

CMD ["bun", "room-server.mjs"]
