const MetaClient = require('./meta-client');

class CampaignEngine {
  constructor(db, io) {
    this.db = db;
    this.io = io;
    this.activeCampaigns = new Map();
    this.accountClients = new Map();
  }

  async getClient(accountId) {
    if (this.accountClients.has(accountId)) return this.accountClients.get(accountId);
    const account = await this.db.getAccountById(accountId);
    if (!account) throw new Error('Conta WhatsApp nao encontrada');
    if (!account.is_active) throw new Error('Conta WhatsApp desativada');
    const client = new MetaClient(account.meta_access_token, account.meta_phone_number_id);
    this.accountClients.set(accountId, client);
    return client;
  }

  invalidateClient(accountId) { this.accountClients.delete(accountId); }

  async startCampaign(campaignId) {
    const campaign = await this.db.getCampaignById(campaignId);
    if (!campaign) throw new Error('Campanha nao encontrada');
    if (campaign.status === 'running') throw new Error('Campanha ja esta em execucao');
    if (campaign.status === 'completed') throw new Error('Campanha ja foi concluida');

    const account = await this.db.getAccountById(campaign.account_id);
    if (!account) throw new Error('Conta WhatsApp nao encontrada');
    const client = await this.getClient(campaign.account_id);

    const templateCheck = await this._verifyTemplate(client, account, campaign.template_name, campaign.template_language);
    if (!templateCheck.success) throw new Error(templateCheck.error);

    let contacts = [];
    if (campaign.target_contacts && campaign.target_contacts.length > 0) {
      contacts = campaign.target_contacts.map(phone => ({ phone }));
    } else if (campaign.target_tags && campaign.target_tags.length > 0) {
      for (const tag of campaign.target_tags) {
        const tagged = await this.db.getContacts(campaign.account_id, { tag, limit: 10000 });
        contacts.push(...tagged);
      }
      const seen = new Set();
      contacts = contacts.filter(c => { if (seen.has(c.phone)) return false; seen.add(c.phone); return true; });
    }

    if (contacts.length === 0) throw new Error('Nenhum contato encontrado para esta campanha');

    await this.db.query('UPDATE campaigns SET total_contacts = $1, status = $2, started_at = NOW() WHERE id = $3', [contacts.length, 'running', campaignId]);

    const control = { running: true, cancelled: false };
    this.activeCampaigns.set(campaignId, control);

    this._emitProgress(account.user_id, campaignId, { status: 'running', total: contacts.length, sent: 0, failed: 0, message: 'Campanha iniciada' });

    this._executeCampaign(client, campaign, contacts, control).catch(err => {
      console.error('Erro fatal na campanha ' + campaignId + ':', err);
    });

    return {
      success: true, campaignId, totalContacts: contacts.length,
      estimatedTimeMinutes: Math.ceil((contacts.length * (campaign.delay_ms || 1000)) / 60000)
    };
  }

  cancelCampaign(campaignId) {
    const control = this.activeCampaigns.get(campaignId);
    if (!control || !control.running) return { success: false, error: 'Campanha nao esta em execucao' };
    control.cancelled = true;
    return { success: true, message: 'Campanha sera cancelada apos o envio atual' };
  }

  async _executeCampaign(client, campaign, contacts, control) {
    const campaignId = campaign.id;
    const account = await this.db.getAccountById(campaign.account_id);
    const delayMs = campaign.delay_ms || 1000;
    let sent = 0, failed = 0;

    console.log('Campanha ' + campaignId + ': Disparando para ' + contacts.length + ' contatos');

    for (let i = 0; i < contacts.length; i++) {
      if (control.cancelled) {
        await this.db.updateCampaignStatus(campaignId, 'cancelled');
        this._emitProgress(account.user_id, campaignId, { status: 'cancelled', total: contacts.length, sent, failed, message: 'Campanha cancelada. ' + sent + ' mensagens enviadas.' });
        break;
      }

      const contact = contacts[i];
      const phone = contact.phone.replace(/\\D/g, '');

      try {
        const components = this._buildTemplateComponents(campaign.template_variables, contact);
        const result = await client.sendTemplate(phone, campaign.template_name, campaign.template_language || 'pt_BR', components);

        if (result.success) {
          sent++;
          await this.db.incrementCampaignCount(campaignId, 'sent_count');
          await this.db.saveMessage({
            accountId: campaign.account_id, metaMessageId: result.messageId, contactPhone: phone,
            direction: 'outgoing', type: 'template',
            content: { template: campaign.template_name, variables: campaign.template_variables },
            templateName: campaign.template_name, status: 'sent', campaignId: campaignId, costCategory: 'marketing'
          });
          await this.db.updateContactLastMessage(campaign.account_id, phone);
        } else {
          failed++;
          await this.db.incrementCampaignCount(campaignId, 'failed_count');
          await this.db.saveMessage({
            accountId: campaign.account_id, contactPhone: phone, direction: 'outgoing', type: 'template',
            content: { template: campaign.template_name, error: result.friendlyError || result.error },
            templateName: campaign.template_name, status: 'failed', campaignId: campaignId
          });
        }
      } catch (error) {
        failed++;
        await this.db.incrementCampaignCount(campaignId, 'failed_count');
      }

      if ((i + 1) % 5 === 0 || i === contacts.length - 1) {
        this._emitProgress(account.user_id, campaignId, {
          status: 'running', total: contacts.length, sent, failed,
          progress: Math.round(((i + 1) / contacts.length) * 100),
          message: 'Enviando... ' + (i + 1) + '/' + contacts.length
        });
      }

      if (i < contacts.length - 1) await this._delay(delayMs);
    }

    if (!control.cancelled) {
      await this.db.updateCampaignStatus(campaignId, 'completed');
      this._emitProgress(account.user_id, campaignId, {
        status: 'completed', total: contacts.length, sent, failed,
        message: 'Campanha finalizada! ' + sent + ' enviadas, ' + failed + ' falharam.'
      });
    }

    control.running = false;
    this.activeCampaigns.delete(campaignId);
  }

  async _verifyTemplate(client, account, templateName, language) {
    if (account.meta_waba_id) {
      const result = await client.getTemplates(account.meta_waba_id);
      if (result.success) {
        const template = result.templates.find(t => t.name === templateName && t.language === (language || 'pt_BR'));
        if (!template) return { success: false, error: 'Template "' + templateName + '" nao encontrado na sua conta Meta.' };
        if (template.status !== 'APPROVED') return { success: false, error: 'Template "' + templateName + '" esta com status "' + template.status + '".' };
        await this.db.upsertTemplate(account.id, template);
        return { success: true, template };
      }
    }
    const local = await this.db.getTemplateByName(account.id, templateName, language);
    if (!local) return { success: false, error: 'Template "' + templateName + '" nao encontrado.' };
    if (local.status !== 'APPROVED') return { success: false, error: 'Template nao aprovado (status: ' + local.status + ')' };
    return { success: true, template: local };
  }

  _buildTemplateComponents(templateVariables, contact) {
    if (!templateVariables || Object.keys(templateVariables).length === 0) return [];
    const components = [];
    if (templateVariables.header) {
      components.push({ type: 'header', parameters: templateVariables.header.map(v => this._resolveVariable(v, contact)) });
    }
    if (templateVariables.body) {
      components.push({ type: 'body', parameters: templateVariables.body.map(v => this._resolveVariable(v, contact)) });
    }
    if (templateVariables.buttons) {
      templateVariables.buttons.forEach((btn, index) => {
        components.push({ type: 'button', sub_type: btn.subType || 'url', index, parameters: btn.parameters.map(v => this._resolveVariable(v, contact)) });
      });
    }
    return components;
  }

  _resolveVariable(variable, contact) {
    if (typeof variable === 'string') {
      let resolved = variable;
      resolved = resolved.replace('{{name}}', contact.name || 'Cliente');
      resolved = resolved.replace('{{phone}}', contact.phone || '');
      resolved = resolved.replace('{{email}}', contact.email || '');
      if (contact.custom_fields) {
        for (const [key, value] of Object.entries(contact.custom_fields)) {
          resolved = resolved.replace('{{' + key + '}}', value || '');
        }
      }
      return { type: 'text', text: resolved };
    }
    return variable;
  }

  _delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  _emitProgress(userId, campaignId, data) {
    if (this.io) this.io.to('user_' + userId).emit('campaign_progress', { campaignId, ...data });
  }
}

module.exports = CampaignEngine;
