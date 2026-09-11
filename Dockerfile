FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    libxfixes3 libx11-xcb1 libxcb1 libxext6 libx11-6 \
    libxcb-dri3-0 libxcursor1 libxi6 libxtst6 \
    fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

ENV PLAYWRIGHT_BROWSERS_PATH=/app/pw-browsers
RUN npx playwright install chromium

COPY . .

RUN mkdir -p salidas solicitudes

ENV PORT=3000
EXPOSE 3000

CMD export RUTA_CHROMIUM=$(find /app/pw-browsers -name "chrome-headless-shell" | head -1) && node server.js
