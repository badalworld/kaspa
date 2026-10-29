# Kaspa Mining Console — all-in-one image (panel + kaspad + kaspa-miner)
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip tini procps \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Panel sources (no npm dependencies required)
COPY package.json ./
COPY server ./server
COPY public ./public

# Official binaries
ARG MINER_VERSION=v0.2.7
ARG NODE_VERSION=v2.1.0
RUN set -eux; \
    mkdir -p /opt/kaspa-bin; \
    curl -fsSL -o /opt/kaspa-bin/kaspa-miner \
      "https://github.com/kaspanet/cpuminer/releases/download/${MINER_VERSION}/kaspa-miner-${MINER_VERSION}-linux-gnu-amd64"; \
    chmod +x /opt/kaspa-bin/kaspa-miner; \
    curl -fsSL -o /tmp/kaspad.zip \
      "https://github.com/kaspanet/rusty-kaspa/releases/download/${NODE_VERSION}/rusty-kaspa-${NODE_VERSION}-linux-amd64.zip"; \
    unzip -o -q /tmp/kaspad.zip -d /tmp/kaspad; \
    find /tmp/kaspad -name kaspad -type f -exec cp {} /opt/kaspa-bin/kaspad \;; \
    chmod +x /opt/kaspa-bin/kaspad; \
    rm -rf /tmp/kaspad /tmp/kaspad.zip

ENV DATA_DIR=/app/data
ENV BIN_DIR=/opt/kaspa-bin
EXPOSE 8080 16111 16110

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PANEL_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
