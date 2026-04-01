const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const cron = require('node-cron');
require('dotenv').config();

const Database = require('./database');
const MetaClient = require('./meta-client');
const CampaignEngine = require('./campaign-engine');
const WebhookHandler = require('./webhook-handler');
const { generateToken, authMiddleware, adminMiddleware } = require('./auth');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const db = new Database();
const campaignEngine = new CampaignEngine(db, io);
const webhookHandler = new WebhookHandler(db, io, campaignEngine);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Socket.IO
io.on('connection', (socket) => {
  socket.on('authenticate', (token) => {
    const jwt = require('jsonwebtoken');
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'prospecflow-secret-change-in-production');
      socket.join(`user_${decoded.userId}`);
      socket.emit('authenticated', { success: true });
    } catch (e) {
      socket.emit('auth_error', { error: 'Token inválido' });
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    name: 'ProspecFlow WhatsApp Platform',
    version: '1.0.0',
    status: 'online',
    dbReady: db.initialized,
    engine: 'Meta Cloud API (oficial)',
    docs: '/api/docs'
  });
});

app.get('/health', async (req, res) => {
  try {
    if (db.initialized) {
      await db.query('SELECT 1');
    }
    res.json({
      status: 'ok',
      dbReady: db.initialized,
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// WEBHOOK DA META (recebe mensagens e status)
// Estes endpoints NÃO TÊM autenticação — a Meta precisa acessar
// ══════════════════════════════════════════════════════════════════

app.get('/webhook', (req, res) => webhookHandler.handleVerification(req, res));
app.post('/webhook', (req, res) => webhookHandler.handleIncoming(req, res));

// ══════════════════════════════════════════════════════════════════
// AUTH — Registro e Login
// ══════════════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, company } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, senha e nome são obrigatórios' });
    }
    const existing = await db.getUserByEmail(email);
    if (existing) return res.status(400).json({ error: 'Email já cadastrado' });
    const userId = await db.createUser(email, password, name, company);
    const token = generateToken(userId);
    res.json({ success: true, token, user: { id: userId, email, name, company } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });
    const user = await db.getUserByEmail(email);
    if (!user || !db.verifyPassword(password, user.password)) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const token = generateToken(user.id, user.role);
    const accounts = await db.getAccountsByUser(user.id);
    res.json({
      success: true, token,
      user: { id: user.id, email: user.email, name: user.name, company: user.company, role: user.role },
      accounts
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await db.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const accounts = await db.getAccountsByUser(req.userId);
    res.json({ success: true, user, accounts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// CONTAS WHATSAPP — Conectar número via Cloud API
// ══════════════════════════════════════════════════════════════════

app.post('/api/accounts', authMiddleware, async (req, res) => {
  try {
    const { label, accessToken, phoneNumberId, wabaId, businessId } = req.body;
    if (!accessToken || !phoneNumberId) {
      return res.status(400).json({
        error: 'accessToken e phoneNumberId são obrigatórios',
        help: 'Obtenha-os em: developers.facebook.com > Seu App > WhatsApp > Configuração da API'
      });
    }
    const client = new MetaClient(accessToken, phoneNumberId);
    const validation = await client.validateToken();
    if (!validation.success) {
      return res.status(400).json({
        error: 'Token inválido ou Phone Number ID incorreto',
        details: validation.error,
        help: 'Verifique se o Access Token é válido e se o Phone Number ID corresponde ao número registrado.'
      });
    }
    const phoneInfo = await client.getPhoneNumberInfo();
    const account = await db.createAccount(req.userId, {
      label: label || validation.verifiedName || 'Minha conta',
      accessToken, phoneNumberId,
      wabaId: wabaId || null, businessId: businessId || null,
      phoneNumber: validation.phoneNumber,
      displayName: validation.verifiedName
    });
    if (phoneInfo.success && phoneInfo.info) {
      await db.updateAccountQuality(
        account.id,
        phoneInfo.info.quality_rating || 'unknown',
        phoneInfo.info.messaging_limit_tier || 'TIER_1K'
      );
    }
    if (wabaId) {
      syncTemplates(client, account.id, wabaId).catch(e =>
        console.error('Erro ao sincronizar templates:', e.message)
      );
    }
    res.json({
      success: true,
      account: {
        id: account.id, label: account.label,
        phoneNumber: validation.phoneNumber,
        displayName: validation.verifiedName,
        qualityRating: phoneInfo.info?.quality_rating,
        messagingLimit: phoneInfo.info?.messaging_limit_tier
      },
      message: 'Conta WhatsApp conectada com sucesso! Agora configure o webhook da Meta para receber mensagens.',
      webhookSetup: {
        url: `${process.env.API_URL || `http://localhost:${PORT}`}/webhook`,
        verifyToken: account.webhook_verify_token,
        instructions: 'Configure este URL como Webhook no Meta Developers > Seu App > WhatsApp > Configuração > Webhook'
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sync templates helper
async function syncTemplates(client, accountId, wabaId) {
  const result = await client.getTemplates(wabaId);
  if (result.success) {
    for (const t of result.templates) {
      await db.upsertTemplate(accountId, t);
    }
    console.log(`${result.templates.length} templates sincronizados para conta ${accountId}`);
  }
}

app.get('/api/accounts', authMiddleware, async (req, res) => {
  try {
    const accounts = await db.getAccountsByUser(req.userId);
    res.json({ success: true, accounts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/accounts/:accountId', authMiddleware, async (req, res) => {
  try {
    const account = await db.getAccountById(req.params.accountId);
    if (!account || account.user_id !== req.userId) {
      return res.status(404).json({ error: 'Conta não encontrada' });
    }
    const stats = await db.getAccountStats(account.id);
    const { meta_access_token, ...safeAccount } = account;
    safeAccount.tokenPreview = meta_access_token.substring(0, 20) + '...';
    res.json({ success: true, account: safeAccount, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/accounts/:accountId/token', authMiddleware, async (req, res) => {
  try {
    const account = await db.getAccountById(req.params.accountId);
    if (!account || account.user_id !== req.userId) {
      return res.status(404).json({ error: 'Conta não encontrada' });
    }
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'accessToken obrigatório' });
    const client = new MetaClient(accessToken, account.meta_phone_number_id);
    const validation = await client.validateToken();
    if (!validation.success) {
      return res.status(400).json({ error: 'Novo token inválido', details: validation.error });
    }
    await db.updateAccountToken(account.id, accessToken);
    campaignEngine.invalidateClient(account.id);
    res.json({ success: true, message: 'Token atualizado com sucesso' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// ENVIO DE MENSAGENS
// ══════════════════════════════════════════════════════════════════

async function accountAccess(req, res, next) {
  const account = await db.getAccountById(req.params.accountId);
  if (!account || account.user_id !== req.userId) {
    return res.status(404).json({ error: 'Conta não encontrada' });
  }
  req.account = account;
  next();
}

app.post('/api/accounts/:accountId/send/text', authMiddleware, accountAccess, async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: '"to" e "message" são obrigatórios' });
    const client = await campaignEngine.getClient(req.account.id);
    const result = await client.sendText(to, message);
    if (result.success) {
      await db.saveMessage({
        accountId: req.account.id, metaMessageId: result.messageId,
        contactPhone: to.replace(/\D/g, ''), direction: 'outgoing',
        type: 'text', content: { text: message }, status: 'sent', costCategory: 'service'
      });
      await db.upsertContact(req.account.id, to.replace(/\D/g, ''));
      await db.updateContactLastMessage(req.account.id, to.replace(/\D/g, ''));
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:accountId/send/template', authMiddleware, accountAccess, async (req, res) => {
  try {
    const { to, templateName, language, components } = req.body;
    if (!to || !templateName) return res.status(400).json({ error: '"to" e "templateName" são obrigatórios' });
    const client = await campaignEngine.getClient(req.account.id);
    const result = await client.sendTemplate(to, templateName, language || 'pt_BR', components || []);
    if (result.success) {
      await db.saveMessage({
        accountId: req.account.id, metaMessageId: result.messageId,
        contactPhone: to.replace(/\D/g, ''), direction: 'outgoing',
        type: 'template', content: { template: templateName, components },
        templateName, status: 'sent', costCategory: 'marketing'
      });
      await db.upsertContact(req.account.id, to.replace(/\D/g, ''));
      await db.updateContactLastMessage(req.account.id, to.replace(/\D/g, ''));
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:accountId/send/image', authMiddleware, accountAccess, async (req, res) => {
  try {
    const { to, imageUrl, caption } = req.body;
    if (!to || !imageUrl) return res.status(400).json({ error: '"to" e "imageUrl" são obrigatórios' });
    const client = await campaignEngine.getClient(req.account.id);
    const result = await client.sendImage(to, imageUrl, caption);
    if (result.success) {
      await db.saveMessage({
        accountId: req.account.id, metaMessageId: result.messageId,
        contactPhone: to.replace(/\D/g, ''), direction: 'outgoing',
        type: 'image', content: { imageUrl, caption }, status: 'sent', costCategory: 'service'
      });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:accountId/send/document', authMiddleware, accountAccess, async (req, res) => {
  try {
    const { to, documentUrl, filename, caption } = req.body;
    if (!to || !documentUrl) return res.status(400).json({ error: '"to" e "documentUrl" são obrigatórios' });
    const client = await campaignEngine.getClient(req.account.id);
    const result = await client.sendDocument(to, documentUrl, filename, caption);
    if (result.success) {
      await db.saveMessage({
        accountId: req.account.id, metaMessageId: result.messageId,
        contactPhone: to.replace(/\D/g, ''), direction: 'outgoing',
        type: 'document', content: { documentUrl, filename, caption }, status: 'sent', costCategory: 'service'
      });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:accountId/send/buttons', authMiddleware, accountAccess, async (req, res) => {
  try {
    const { to, body, buttons, header, footer } = req.body;
    if (!to || !body || !buttons) return res.status(400).json({ error: '"to", "body" e "buttons" são obrigatórios' });
    const client = await campaignEngine.getClient(req.account.id);
    const result = await client.sendButtons(to, body, buttons, header, footer);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:accountId/send/list', authMiddleware, accountAccess, async (req, res) => {
  try {
    const { to, body, buttonText, sections, header, footer } = req.body;
    if (!to || !body || !sections) return res.status(400).json({ error: '"to", "body" e "sections" são obrigatórios' });
    const client = await campaignEngine.getClient(req.account.id);
    const result = await client.sendList(to, body, buttonText, sections, header, footer);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// TEMPLATES
// ══════════════════════════════════════════════════════════════════

app.get('/api/accounts/:accountId/templates', authMiddleware, accountAccess, async (req, res) => {
  try {
    if (req.account.meta_waba_id) {
      const client = await campaignEngine.getClient(req.account.id);
      await syncTemplates(client, req.account.id, req.account.meta_waba_id);
    }
    const templates = await db.getTemplatesByAccount(req.account.id);
    res.json({ success: true, templates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:accountId/templates', authMiddleware, accountAccess, async (req, res) => {
  try {
    if (!req.account.meta_waba_id) {
      return res.status(400).json({
        error: 'WABA ID não configurado. Atualize a conta com o wabaId para poder criar templates.',
        help: 'O WABA ID está em: Meta Business Suite > Configurações > WhatsApp Accounts'
      });
    }
    const { name, category, language, components } = req.body;
    if (!name || !category) return res.status(400).json({ error: '"name" e "category" são obrigatórios' });
    const client = await campaignEngine.getClient(req.account.id);
    const result = await client.createTemplate(req.account.meta_waba_id, {
      name, category: category.toUpperCase(),
      language: language || 'pt_BR',
      components: components || []
    });
    if (result.success) {
      const template = await db.upsertTemplate(req.account.id, {
        id: result.template.id, name,
        language: language || 'pt_BR',
        category: category.toUpperCase(),
        status: result.template.status || 'PENDING',
        components: components || []
      });
      res.json({ success: true, template, message: 'Template submetido para aprovação da Meta. Status será atualizado automaticamente.' });
    } else {
      res.status(400).json({ success: false, error: result.friendlyError || result.error, details: result.details });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/templates/presets', authMiddleware, (req, res) => {
  res.json({
    success: true,
    presets: [
      {
        name: 'boas_vindas', category: 'MARKETING',
        description: 'Mensagem de boas-vindas para novos contatos',
        components: [{ type: 'BODY', text: 'Olá {{1}}! Bem-vindo(a) à {{2}}. Como podemos ajudá-lo(a) hoje?' }],
        variables: { body: ['{{name}}', '{{company}}'] }
      },
      {
        name: 'confirmacao_agendamento', category: 'UTILITY',
        description: 'Confirmação de agendamento/reunião',
        components: [{ type: 'BODY', text: 'Olá {{1}}, sua reunião está confirmada para {{2}} às {{3}}. Caso precise remarcar, entre em contato.' }],
        variables: { body: ['{{name}}', '{{date}}', '{{time}}'] }
      },
      {
        name: 'lembrete_pagamento', category: 'UTILITY',
        description: 'Lembrete de pagamento pendente',
        components: [{ type: 'BODY', text: 'Olá {{1}}, este é um lembrete amigável sobre seu pagamento de R$ {{2}} com vencimento em {{3}}. Qualquer dúvida, estamos à disposição.' }],
        variables: { body: ['{{name}}', '{{value}}', '{{date}}'] }
      },
      {
        name: 'promocao_desconto', category: 'MARKETING',
        description: 'Promoção com desconto',
        components: [{ type: 'BODY', text: '{{1}}, temos uma oferta especial para você! {{2}}% de desconto em {{3}}. Válido até {{4}}. Aproveite!' }],
        variables: { body: ['{{name}}', '{{discount}}', '{{product}}', '{{expiry}}'] }
      },
      {
        name: 'follow_up_proposta', category: 'MARKETING',
        description: 'Follow-up de proposta comercial',
        components: [{ type: 'BODY', text: 'Olá {{1}}, tudo bem? Gostaríamos de saber se teve a oportunidade de analisar nossa proposta sobre {{2}}. Ficamos à disposição para esclarecer qualquer dúvida.' }],
        variables: { body: ['{{name}}', '{{proposal_subject}}'] }
      },
      {
        name: 'codigo_verificacao', category: 'AUTHENTICATION',
        description: 'Código de verificação/OTP',
        components: [{ type: 'BODY', text: 'Seu código de verificação é: {{1}}. Válido por 10 minutos. Não compartilhe com ninguém.' }],
        variables: { body: ['{{code}}'] }
      }
    ]
  });
});

// ══════════════════════════════════════════════════════════════════
// CONTATOS
// ══════════════════════════════════════════════════════════════════

app.get('/api/accounts/:accountId/contacts', authMiddleware, accountAccess, async (req, res) => {
  try {
    const { limit, offset, tag, search } = req.query;
    const contacts = await db.getContacts(req.account.id, {
      limit: parseInt(limit) || 100, offset: parseInt(offset) || 0, tag, search
    });
    res.json({ success: true, contacts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:accountId/contacts', authMiddleware, accountAccess, async (req, res) => {
  try {
    const { phone, name, email, tags, customFields, optedIn } = req.body;
    if (!phone) return res.status(400).json({ error: '"phone" é obrigatório' });
    const contact = await db.upsertContact(req.account.id, phone.replace(/\D/g, ''), {
      name, email, tags, customFields, optedIn
    });
    res.json({ success: true, contact });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:accountId/contacts/import', authMiddleware, accountAccess, async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!contacts || !Array.isArray(contacts)) {
      return res.status(400).json({ error: '"contacts" deve ser um array de objetos com pelo menos { phone }' });
    }
    const imported = await db.importContacts(req.account.id, contacts.map(c => ({
      ...c, phone: c.phone?.replace(/\D/g, '')
    })));
    res.json({ success: true, imported, total: contacts.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// MENSAGENS
// ══════════════════════════════════════════════════════════════════

app.get('/api/accounts/:accountId/messages/:phone', authMiddleware, accountAccess, async (req, res) => {
  try {
    const messages = await db.getMessages(req.account.id, req.params.phone, parseInt(req.query.limit) || 50);
    res.json({ success: true, messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// CAMPANHAS
// ══════════════════════════════════════════════════════════════════

app.get('/api/accounts/:accountId/campaigns', authMiddleware, accountAccess, async (req, res) => {
  try {
    const campaigns = await db.getCampaigns(req.account.id);
    res.json({ success: true, campaigns });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:accountId/campaigns', authMiddleware, accountAccess, async (req, res) => {
  try {
    const { name, templateName, templateLanguage, templateVariables, targetContacts, targetTags, delayMs, scheduledAt } = req.body;
    if (!name || !templateName) {
      return res.status(400).json({ error: '"name" e "templateName" são obrigatórios' });
    }
    if (!targetContacts?.length && !targetTags?.length) {
      return res.status(400).json({ error: 'Informe "targetContacts" (lista de números) ou "targetTags" (tags de contatos)' });
    }
    let totalContacts = 0;
    if (targetContacts?.length) {
      totalContacts = targetContacts.length;
    } else if (targetTags?.length) {
      for (const tag of targetTags) {
        const tagged = await db.getContacts(req.account.id, { tag, limit: 100000 });
        totalContacts += tagged.length;
      }
    }
    const campaign = await db.createCampaign(req.account.id, {
      name, templateName, templateLanguage, templateVariables,
      targetContacts, targetTags, totalContacts, delayMs, scheduledAt
    });
    res.json({ success: true, campaign });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:accountId/campaigns/:campaignId/start', authMiddleware, accountAccess, async (req, res) => {
  try {
    const result = await campaignEngine.startCampaign(parseInt(req.params.campaignId));
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/accounts/:accountId/campaigns/:campaignId/cancel', authMiddleware, accountAccess, async (req, res) => {
  try {
    const result = campaignEngine.cancelCampaign(parseInt(req.params.campaignId));
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// AUTO-RESPOSTAS
// ══════════════════════════════════════════════════════════════════

app.get('/api/accounts/:accountId/auto-replies', authMiddleware, accountAccess, async (req, res) => {
  try {
    const rules = await db.getAutoReplies(req.account.id);
    res.json({ success: true, rules });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:accountId/auto-replies', authMiddleware, accountAccess, async (req, res) => {
  try {
    const { triggerType, triggerValue, responseType, responseContent, priority } = req.body;
    if (!triggerType || !triggerValue || !responseContent) {
      return res.status(400).json({ error: '"triggerType", "triggerValue" e "responseContent" são obrigatórios' });
    }
    const rule = await db.createAutoReply(req.account.id, {
      triggerType, triggerValue, responseType, responseContent, priority
    });
    res.json({ success: true, rule });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// WEBHOOKS DO CLIENTE
// ══════════════════════════════════════════════════════════════════

app.get('/api/accounts/:accountId/webhooks', authMiddleware, accountAccess, async (req, res) => {
  try {
    const webhooks = await db.getClientWebhooks(req.account.id);
    res.json({ success: true, webhooks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:accountId/webhooks', authMiddleware, accountAccess, async (req, res) => {
  try {
    const { url, events, secret } = req.body;
    if (!url) return res.status(400).json({ error: '"url" é obrigatório' });
    const webhook = await db.createClientWebhook(
      req.account.id, url,
      events || ['message.received', 'message.status'],
      secret
    );
    res.json({ success: true, webhook });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// DASHBOARD / STATS
// ══════════════════════════════════════════════════════════════════

app.get('/api/accounts/:accountId/stats', authMiddleware, accountAccess, async (req, res) => {
  try {
    const stats = await db.getAccountStats(req.account.id);
    res.json({ success: true, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// DOCUMENTAÇÃO INTERATIVA
// ══════════════════════════════════════════════════════════════════

app.get('/api/docs', (req, res) => {
  const baseUrl = process.env.API_URL || `http://localhost:${PORT}`;
  res.json({
    name: 'ProspecFlow WhatsApp Platform API',
    version: '1.0.0',
    baseUrl,
    description: 'Plataforma de WhatsApp Business via Cloud API oficial da Meta. Zero Chromium, zero QR Code.',
    quickStart: [
      '1. POST /api/auth/register — Crie sua conta',
      '2. POST /api/accounts — Conecte seu WhatsApp (Access Token + Phone Number ID)',
      '3. POST /api/accounts/:id/send/text — Envie sua primeira mensagem',
      '4. POST /api/accounts/:id/campaigns — Crie uma campanha de disparo em massa'
    ],
    endpoints: {
      auth: {
        'POST /api/auth/register': 'Criar conta',
        'POST /api/auth/login': 'Login',
        'GET /api/auth/me': 'Info do usuário logado'
      },
      accounts: {
        'POST /api/accounts': 'Conectar conta WhatsApp',
        'GET /api/accounts': 'Listar contas',
        'GET /api/accounts/:id': 'Detalhes + stats',
        'PUT /api/accounts/:id/token': 'Atualizar Access Token'
      },
      messaging: {
        'POST /api/accounts/:id/send/text': 'Enviar texto',
        'POST /api/accounts/:id/send/template': 'Enviar template',
        'POST /api/accounts/:id/send/image': 'Enviar imagem',
        'POST /api/accounts/:id/send/document': 'Enviar documento',
        'POST /api/accounts/:id/send/buttons': 'Enviar botões interativos',
        'POST /api/accounts/:id/send/list': 'Enviar lista interativa'
      },
      templates: {
        'GET /api/accounts/:id/templates': 'Listar templates',
        'POST /api/accounts/:id/templates': 'Criar template',
        'GET /api/templates/presets': 'Templates pré-montados'
      },
      contacts: {
        'GET /api/accounts/:id/contacts': 'Listar contatos',
        'POST /api/accounts/:id/contacts': 'Criar/atualizar contato',
        'POST /api/accounts/:id/contacts/import': 'Importar em massa'
      },
      campaigns: {
        'GET /api/accounts/:id/campaigns': 'Listar campanhas',
        'POST /api/accounts/:id/campaigns': 'Criar campanha',
        'POST /api/accounts/:id/campaigns/:cid/start': 'Iniciar disparo',
        'POST /api/accounts/:id/campaigns/:cid/cancel': 'Cancelar disparo'
      },
      autoReplies: {
        'GET /api/accounts/:id/auto-replies': 'Listar regras',
        'POST /api/accounts/:id/auto-replies': 'Criar regra'
      },
      webhooks: {
        'GET /webhook': 'Verificação Meta',
        'POST /webhook': 'Recebe eventos Meta',
        'GET /api/accounts/:id/webhooks': 'Listar webhooks',
        'POST /api/accounts/:id/webhooks': 'Criar webhook'
      },
      dashboard: {
        'GET /api/accounts/:id/stats': 'Estatísticas'
      }
    },
    socketIO: {
      events: {
        'message_received': 'Mensagem recebida',
        'message_status': 'Status atualizado',
        'campaign_progress': 'Progresso de campanha'
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// CRON JOBS
// ══════════════════════════════════════════════════════════════════

cron.schedule('* * * * *', async () => {
  if (!db.initialized) return;
  try {
    const scheduled = await db.all(
      "SELECT * FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= NOW()"
    );
    for (const campaign of scheduled) {
      console.log(`Iniciando campanha agendada: ${campaign.name} (ID: ${campaign.id})`);
      campaignEngine.startCampaign(campaign.id).catch(e =>
        console.error(`Erro ao iniciar campanha agendada ${campaign.id}:`, e.message)
      );
    }
  } catch (e) {
    console.error('Erro no cron de campanhas:', e.message);
  }
});

// ══════════════════════════════════════════════════════════════════
// START — Server first, then DB init (so health check passes)
// ══════════════════════════════════════════════════════════════════

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ProspecFlow v1.0.0 | Port: ${PORT} | Status: LISTENING`);
  console.log('Iniciando conexão com banco de dados...');

  db.initialize().then(() => {
    console.log('ProspecFlow totalmente operacional!');
  }).catch((err) => {
    console.error('ERRO FATAL: Não foi possível conectar ao banco:', err.message);
    console.error('O servidor continuará respondendo, mas funcionalidades que dependem do DB falharão.');
  });
});
