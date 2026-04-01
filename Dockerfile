# ══════════════════════════════════════════════════════════════
# ProspecFlow WhatsApp Platform
# Image LEVE — SEM Chromium (não precisa mais!)
# ~50MB vs ~800MB da versão anterior
# ══════════════════════════════════════════════════════════════
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

EXPOSE 8000

CMD ["npm", "start"]
