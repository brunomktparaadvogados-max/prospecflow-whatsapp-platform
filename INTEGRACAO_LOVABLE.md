# Integração com Lovable (ProspecFlow)

## Variável de Ambiente no Lovable

```
VITE_WHATSAPP_API_URL=https://SUA-URL-KOYEB.koyeb.app
```

## Fluxo de Autenticação

```
POST /api/auth/login
Body: { "email": "...", "password": "..." }

Resposta:
{
  "success": true,
  "token": "JWT_TOKEN",
  "user": { "id": 1, "name": "...", "email": "..." },
  "accounts": [
    { "id": 1, "label": "Meu WhatsApp", "phone_number": "+5511...", "display_name": "..." }
  ]
}
```

Salve o token e use em todas as requisições: `Authorization: Bearer TOKEN`

## Conectar WhatsApp (substituindo QR Code)

Não precisa mais de QR Code. O cliente fornece o Access Token e Phone Number ID do Meta:

```
POST /api/accounts
Headers: { Authorization: Bearer TOKEN }
Body: {
  "label": "WhatsApp da Empresa",
  "accessToken": "EAAxxxxxxx",
  "phoneNumberId": "123456789",
  "wabaId": "987654321"
}
```

A API valida automaticamente e retorna o status da conexão.

## Enviar Mensagens

### Texto simples (dentro da janela de 24h):
```
POST /api/accounts/1/send/text
Body: { "to": "5511999999999", "message": "Olá!" }
```

### Template (qualquer hora — método principal):
```
POST /api/accounts/1/send/template
Body: {
  "to": "5511999999999",
  "templateName": "boas_vindas",
  "language": "pt_BR",
  "components": [
    {
      "type": "body",
      "parameters": [
        { "type": "text", "text": "João" },
        { "type": "text", "text": "ProspecFlow" }
      ]
    }
  ]
}
```

## Disparo em Massa

### 1. Importar contatos:
```
POST /api/accounts/1/contacts/import
Body: {
  "contacts": [
    { "phone": "5511999999999", "name": "João", "tags": ["clientes"], "optedIn": true },
    { "phone": "5511888888888", "name": "Maria", "tags": ["clientes", "vip"] }
  ]
}
```

### 2. Criar campanha:
```
POST /api/accounts/1/campaigns
Body: {
  "name": "Promoção Janeiro",
  "templateName": "promocao_desconto",
  "templateVariables": {
    "body": ["{{name}}", "20", "consultoria jurídica", "31/01/2026"]
  },
  "targetTags": ["clientes"],
  "delayMs": 1500
}
```

### 3. Iniciar disparo:
```
POST /api/accounts/1/campaigns/1/start
```

### 4. Acompanhar progresso (Socket.IO):
```javascript
socket.on('campaign_progress', (data) => {
  // { campaignId, status, total, sent, failed, progress, message }
});
```

## Receber Mensagens em Tempo Real (Socket.IO)

```javascript
import { io } from 'socket.io-client';

const socket = io('https://SUA-URL.koyeb.app');
socket.emit('authenticate', 'SEU_JWT_TOKEN');

socket.on('message_received', (data) => {
  // { accountId, from, contactName, type, content, timestamp }
  console.log(\`Mensagem de \${data.contactName}: \${data.content.text}\`);
});

socket.on('message_status', (data) => {
  // { accountId, messageId, status, recipientPhone }
  console.log(\`Mensagem \${data.messageId}: \${data.status}\`);
});
```

## Auto-Respostas (Chatbot)

```
POST /api/accounts/1/auto-replies
Body: {
  "triggerType": "contains",
  "triggerValue": "preço",
  "responseType": "text",
  "responseContent": { "text": "Nossos planos começam em R$ 99/mês. Quer saber mais?" },
  "priority": 10
}
```

Tipos de trigger: `exact`, `contains`, `starts_with`, `regex`, `any`

## Templates Pré-Montados

```
GET /api/templates/presets
```

Retorna templates prontos para os casos mais comuns:
- boas_vindas, confirmacao_agendamento, lembrete_pagamento,
  promocao_desconto, follow_up_proposta, codigo_verificacao

## Dashboard / Estatísticas

```
GET /api/accounts/1/stats
```

Retorna: total de contatos, mensagens (enviadas, entregues, lidas, falharam, recebidas), campanhas.

## Configurar Webhook da Meta

Após deploy, configure no Meta Developers:
1. Acesse seu App > WhatsApp > Configuration
2. Em Webhook URL: `https://SUA-URL.koyeb.app/webhook`
3. Em Verify Token: use o valor de `META_WEBHOOK_VERIFY_TOKEN` do .env
4. Clique em Verify and Save
5. Em Webhook Fields: ative `messages`
