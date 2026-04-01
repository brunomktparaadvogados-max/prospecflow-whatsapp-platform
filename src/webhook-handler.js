const axios = require('axios');

class WebhookHandler {
  constructor(db, io, campaignEngine) {
    this.db = db;
    this.io = io;
    this.campaignEngine = campaignEngine;
  }

  handleVerification(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'prospecflow_webhook_2024';
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verificado pela Meta');
      return res.status(200).send(challenge);
    }
    console.log('Falha na verificacao do webhook');
    return res.sendStatus(403);
  }

  async handleIncoming(req, res) {
    res.sendStatus(200);
    try {
      const body = req.body;
      if (!body.object || body.object !== 'whatsapp_business_account') return;
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field !== 'messages') continue;
          const value = change.value;
          const phoneNumberId = value.metadata?.phone_number_id;
          if (!phoneNumberId) continue;
          const account = await this.db.getAccountByPhoneNumberId(phoneNumberId);
          if (!account) { console.log('Webhook recebido para phone_number_id desconhecido: ' + phoneNumberId); continue; }
          if (value.messages) {
            for (const message of value.messages) await this._handleIncomingMessage(account, message, value.contacts);
          }
          if (value.statuses) {
            for (const status of value.statuses) await this._handleStatusUpdate(account, status);
          }
        }
      }
    } catch (error) { console.error('Erro ao processar webhook:', error); }
  }

  async _handleIncomingMessage(account, message, contacts) {
    const from = message.from;
    const contactInfo = contacts?.find(c => c.wa_id === from);
    const contactName = contactInfo?.profile?.name || null;
    const content = this._extractMessageContent(message);
    await this.db.upsertContact(account.id, from, { name: contactName });
    await this.db.updateContactLastMessage(account.id, from);
    const savedMessage = await this.db.saveMessage({
      accountId: account.id, metaMessageId: message.id, contactPhone: from,
      direction: 'incoming', type: message.type, content, status: 'received'
    });
    this.io.to('user_' + account.user_id).emit('message_received', {
      accountId: account.id, accountLabel: account.label, messageId: message.id,
      from, contactName, type: message.type, content, timestamp: message.timestamp
    });
    await this._checkAutoReplies(account, from, message);
    await this._triggerClientWebhooks(account.id, 'message.received', {
      accountId: account.id, messageId: message.id, from, contactName,
      type: message.type, content, timestamp: message.timestamp
    });
  }

  async _handleStatusUpdate(account, status) {
    const statusMap = { 'sent': 'sent', 'delivered': 'delivered', 'read': 'read', 'failed': 'failed' };
    const mappedStatus = statusMap[status.status] || status.status;
    const errorMessage = status.errors?.[0]?.message || null;
    await this.db.updateMessageStatus(status.id, mappedStatus, errorMessage);
    if (mappedStatus === 'delivered' || mappedStatus === 'read') {
      const msg = await this.db.get('SELECT campaign_id FROM messages WHERE meta_message_id = $1 AND campaign_id IS NOT NULL', [status.id]);
      if (msg?.campaign_id) {
        const field = mappedStatus === 'delivered' ? 'delivered_count' : 'read_count';
        await this.db.incrementCampaignCount(msg.campaign_id, field);
      }
    }
    this.io.to('user_' + account.user_id).emit('message_status', {
      accountId: account.id, messageId: status.id, status: mappedStatus,
      recipientPhone: status.recipient_id, timestamp: status.timestamp, error: errorMessage
    });
    await this._triggerClientWebhooks(account.id, 'message.status', {
      accountId: account.id, messageId: status.id, status: mappedStatus,
      recipientPhone: status.recipient_id, error: errorMessage
    });
  }

  _extractMessageContent(message) {
    switch (message.type) {
      case 'text': return { text: message.text?.body };
      case 'image': return { mediaId: message.image?.id, caption: message.image?.caption, mimeType: message.image?.mime_type };
      case 'video': return { mediaId: message.video?.id, caption: message.video?.caption, mimeType: message.video?.mime_type };
      case 'audio': return { mediaId: message.audio?.id, mimeType: message.audio?.mime_type };
      case 'document': return { mediaId: message.document?.id, filename: message.document?.filename, caption: message.document?.caption, mimeType: message.document?.mime_type };
      case 'location': return { latitude: message.location?.latitude, longitude: message.location?.longitude, name: message.location?.name, address: message.location?.address };
      case 'contacts': return { contacts: message.contacts };
      case 'interactive': return { type: message.interactive?.type, buttonReply: message.interactive?.button_reply, listReply: message.interactive?.list_reply };
      case 'button': return { text: message.button?.text, payload: message.button?.payload };
      case 'sticker': return { mediaId: message.sticker?.id, animated: message.sticker?.animated };
      case 'reaction': return { emoji: message.reaction?.emoji, messageId: message.reaction?.message_id };
      default: return { raw: message };
    }
  }

  async _checkAutoReplies(account, from, message) {
    if (message.type !== 'text') return;
    const text = message.text?.body?.toLowerCase() || '';
    const autoReplies = await this.db.getAutoReplies(account.id);
    for (const rule of autoReplies) {
      let matched = false;
      switch (rule.trigger_type) {
        case 'exact': matched = text === rule.trigger_value.toLowerCase(); break;
        case 'contains': matched = text.includes(rule.trigger_value.toLowerCase()); break;
        case 'starts_with': matched = text.startsWith(rule.trigger_value.toLowerCase()); break;
        case 'regex': try { matched = new RegExp(rule.trigger_value, 'i').test(text); } catch (e) {} break;
        case 'any': matched = true; break;
      }
      if (matched) {
        const client = await this.campaignEngine.getClient(account.id);
        const response = typeof rule.response_content === 'string' ? JSON.parse(rule.response_content) : rule.response_content;
        if (rule.response_type === 'text') await client.sendText(from, response.text || response.message);
        else if (rule.response_type === 'template') await client.sendTemplate(from, response.templateName, response.language || 'pt_BR', response.components || []);
        else if (rule.response_type === 'buttons') await client.sendButtons(from, response.body, response.buttons, response.header, response.footer);
        await this.db.saveMessage({ accountId: account.id, contactPhone: from, direction: 'outgoing', type: rule.response_type, content: response, status: 'sent' });
        break;
      }
    }
  }

  async _triggerClientWebhooks(accountId, event, data) {
    const webhooks = await this.db.getClientWebhooks(accountId);
    for (const webhook of webhooks) {
      const events = typeof webhook.events === 'string' ? JSON.parse(webhook.events) : webhook.events;
      if (!events.includes(event) && !events.includes('*')) continue;
      try {
        await axios.post(webhook.url, { event, timestamp: new Date().toISOString(), data }, {
          headers: { 'Content-Type': 'application/json', ...(webhook.secret ? { 'X-Webhook-Secret': webhook.secret } : {}) },
          timeout: 10000
        });
        await this.db.query('UPDATE client_webhooks SET last_triggered_at = NOW() WHERE id = $1', [webhook.id]);
      } catch (error) { console.error('Webhook falhou para ' + webhook.url + ':', error.message); }
    }
  }
}

module.exports = WebhookHandler;
