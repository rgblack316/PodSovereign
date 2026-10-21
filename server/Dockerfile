# PodSovereign app image. Built by docker compose (see ../docker-compose.yml).
FROM node:22-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /app

# Dependencies first, so code changes don't reinstall them.
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY web ./web

# Media and uploaded logos live in /data (mounted from the host).
RUN mkdir -p /data/media /data/site && chown -R node:node /data
USER node

ARG FEEDHOST_VERSION=dev
ENV FEEDHOST_VERSION=${FEEDHOST_VERSION} \
    HOST=0.0.0.0 \
    PORT=8080 \
    MEDIA_DIR=/data/media \
    SITE_DIR=/data/site

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "--import", "tsx", "src/server.ts"]
