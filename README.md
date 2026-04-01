# ProspecFlow WhatsApp Platform

Plataforma de WhatsApp Business via **Cloud API oficial da Meta**.
Zero Chromium, zero QR Code, escala ilimitada.

## Comparativo com a API anterior

| Aspecto | API Anterior (whatsapp-web.js) | Esta Plataforma (Cloud API) |
|---|---|---|
| Conexão | QR Code + Chromium | Token + Phone Number ID |
| RAM por usuário | ~300MB (Chromium) | ~0MB (só HTTP) |
| Risco de banimento | Alto | Nulo |
| Docker image | ~800MB | ~50MB |
| Escala | 3-5 sessões | Ilimitada |

## Quick Start

```bash
# 1. Clone
git clone <repo>
cd prospecflow-whatsapp

# 2. Configure
cp .env.example .env
# Edite .env com DATABASE_URL e JWT_SECRET

# 3. Instale e rode
npm install
npm start
```

## Deploy no Koyeb

1. Push para GitHub
2. No Koyeb: New Service > GitHub > selecione o repo
3. Configure env vars: `DATABASE_URL`, `JWT_SECRET`, `API_URL`, `META_WEBHOOK_VERIFY_TOKEN`
4. Deploy — sem buildpack especial, sem Chromium

## Fluxo de uso

1. **Registre-se:** `POST /api/auth/register`
2. **Conecte WhatsApp:** `POST /api/accounts` com Access Token + Phone Number ID
3. **Configure webhook:** No Meta Developers, aponte o webhook para `SUA_URL/webhook`
4. **Envie mensagens:** `POST /api/accounts/:id/send/template`
5. **Crie campanhas:** `POST /api/accounts/:id/campaigns` + `POST .../start`

## Como obter Access Token e Phone Number ID

1. Acesse [developers.facebook.com](https://developers.facebook.com)
2. Crie um App > Adicione o produto WhatsApp
3. Em WhatsApp > API Setup: copie o **Temporary Access Token** e o **Phone Number ID**
4. Para token permanente: crie um System User em Business Settings

## Documentação completa

Acesse `GET /api/docs` para ver todos os endpoints.
