FROM node:22-slim

WORKDIR /app

# Install dependencies for voice/audio (ffmpeg) and curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@latest

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY artifacts/discord-bot/package.json ./artifacts/discord-bot/

RUN pnpm install --no-frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "--import", "tsx/esm", "artifacts/discord-bot/src/index.ts"]
