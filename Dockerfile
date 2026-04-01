# ══════════════════════════════════════════════════════════
# ProspecFlow WhatsApp Platform
# Image LEVE — SEM Chromium (não precisa mais!)
# ~50MB vs ~800MB da versão anterior
# ══════════════════════════════════════════════════════════
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
