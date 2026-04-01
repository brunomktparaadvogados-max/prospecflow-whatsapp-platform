const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

class Database {
  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL é obrigatório');

    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000
    });

    this.initTables();
  }

  async query(sql, params = []) {
    const client = await this.pool.connect();
    try {
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  }

  async get(sql, params = []) {
    const result = await this.query(sql, params);
    return result.rows[0] || null;
  }

  async all(sql, params = []) {
    const result = await this.query(sql, params);
    return result.rows;
  }

  async initTables() {
    await this.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        company TEXT,
        role TEXT DEFAULT 'client',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_accounts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        meta_access_token TEXT NOT NULL,
        meta_phone_number_id TEXT NOT NULL,
        meta_waba_id TEXT,
        meta_business_id TEXT,
        phone_number TEXT,
        display_name TEXT,
        quality_rating TEXT DEFAULT 'unknown',
        messaging_limit TEXT DEFAULT 'TIER_1K',
        is_active BOOLEAN DEFAULT true,
        webhook_verify_token TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS message_templates (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
        meta_template_id TEXT,
        name TEXT NOT NULL,
        language TEXT DEFAULT 'pt_BR',
        category TEXT NOT NULL,
        status TEXT DEFAULT 'PENDING',
        components JSONB DEFAULT '[]',
        example_values JSONB DEFAULT '{}',
        rejection_reason TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(account_id, name, language)
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
        phone TEXT NOT NULL,
        name TEXT,
        email TEXT,
        tags JSONB DEFAULT '[]',
        custom_fields JSONB DEFAULT '{}',
        opted_in BOOLEAN DEFAULT false,
        opted_in_at TIMESTAMP,
        last_message_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(account_id, phone)
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
        meta_message_id TEXT,
        contact_phone TEXT NOT NULL,
        direction TEXT NOT NULL,
        type TEXT NOT NULL,
        content JSONB DEFAULT '{}',
        template_name TEXT,
        status TEXT DEFAULT 'pending',
        error_message TEXT,
        campaign_id INTEGER,
        cost_category TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        template_name TEXT NOT NULL,
        template_language TEXT DEFAULT 'pt_BR',
        template_variables JSONB DEFAULT '{}',
        target_contacts JSONB DEFAULT '[]',
        target_tags JSONB DEFAULT '[]',
        total_contacts INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        delivered_count INTEGER DEFAULT 0,
        read_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'draft',
        scheduled_at TIMESTAMP,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        delay_ms INTEGER DEFAULT 1000,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS auto_replies (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
        trigger_type TEXT NOT NULL,
        trigger_value TEXT NOT NULL,
        response_type TEXT DEFAULT 'text',
        response_content JSONB NOT NULL,
        is_active BOOLEAN DEFAULT true,
        priority INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS client_webhooks (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        events JSONB DEFAULT '["message.received","message.status"]',
        secret TEXT,
        is_active BOOLEAN DEFAULT true,
        last_triggered_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await this.query(`CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id)`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(contact_phone)`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_messages_campaign ON messages(campaign_id)`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id)`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(account_id, phone)`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status)`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_templates_account ON message_templates(account_id)`);

    const adminExists = await this.get('SELECT id FROM users WHERE email = $1', ['admin@prospecflow.com']);
    if (!adminExists) {
      const hash = bcrypt.hashSync('admin123', 10);
      await this.query(
        'INSERT INTO users (email, password, name, company, role) VALUES ($1, $2, $3, $4, $5)',
        ['admin@prospecflow.com', hash, 'Administrador', 'ProspecFlow', 'admin']
      );
      console.log('Admin criado: admin@prospecflow.com');
    }

    console.log('Banco de dados inicializado');
  }

  async createUser(email, password, name, company = null) {
    const hash = bcrypt.hashSync(password, 12);
    const result = await this.query(
      'INSERT INTO users (email, password, name, company) VALUES ($1, $2, $3, $4) RETURNING id',
      [email, hash, name, company]
    );
    return result.rows[0].id;
  }

  async getUserByEmail(email) {
    return this.get('SELECT * FROM users WHERE email = $1', [email]);
  }

  async getUserById(id) {
    return this.get('SELECT id, email, name, company, role, is_active, created_at FROM users WHERE id = $1', [id]);
  }

  verifyPassword(plain, hashed) {
    return bcrypt.compareSync(plain, hashed);
  }

  async createAccount(userId, data) {
    const result = await this.query(`
      INSERT INTO whatsapp_accounts (user_id, label, meta_access_token, meta_phone_number_id, meta_waba_id, meta_business_id, phone_number, display_name, webhook_verify_token)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [userId, data.label, data.accessToken, data.phoneNumberId, data.wabaId || null, data.businessId || null, data.phoneNumber || null, data.displayName || null, data.webhookVerifyToken || require('uuid').v4()]);
    return result.rows[0];
  }

  async getAccountsByUser(userId) {
    return this.all('SELECT id, user_id, label, meta_phone_number_id, phone_number, display_name, quality_rating, messaging_limit, is_active, created_at FROM whatsapp_accounts WHERE user_id = $1 AND is_active = true', [userId]);
  }

  async getAccountById(accountId) {
    return this.get('SELECT * FROM whatsapp_accounts WHERE id = $1', [accountId]);
  }

  async getAccountByPhoneNumberId(phoneNumberId) {
    return this.get('SELECT * FROM whatsapp_accounts WHERE meta_phone_number_id = $1 AND is_active = true', [phoneNumberId]);
  }

  async updateAccountToken(accountId, accessToken) {
    return this.query('UPDATE whatsapp_accounts SET meta_access_token = $1, updated_at = NOW() WHERE id = $2', [accessToken, accountId]);
  }

  async updateAccountQuality(accountId, qualityRating, messagingLimit) {
    return this.query('UPDATE whatsapp_accounts SET quality_rating = $1, messaging_limit = $2, updated_at = NOW() WHERE id = $3', [qualityRating, messagingLimit, accountId]);
  }

  async upsertTemplate(accountId, data) {
    const result = await this.query(`
      INSERT INTO message_templates (account_id, meta_template_id, name, language, category, status, components)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (account_id, name, language) DO UPDATE SET
        meta_template_id = EXCLUDED.meta_template_id,
        status = EXCLUDED.status,
        components = EXCLUDED.components,
        updated_at = NOW()
      RETURNING *
    `, [accountId, data.id || null, data.name, data.language || 'pt_BR', data.category, data.status || 'PENDING', JSON.stringify(data.components || [])]);
    return result.rows[0];
  }

  async getTemplatesByAccount(accountId) {
    return this.all('SELECT * FROM message_templates WHERE account_id = $1 ORDER BY updated_at DESC', [accountId]);
  }

  async getTemplateByName(accountId, name, language = 'pt_BR') {
    return this.get('SELECT * FROM message_templates WHERE account_id = $1 AND name = $2 AND language = $3', [accountId, name, language]);
  }

  async getApprovedTemplates(accountId) {
    return this.all("SELECT * FROM message_templates WHERE account_id = $1 AND status = 'APPROVED' ORDER BY name", [accountId]);
  }

  async upsertContact(accountId, phone, data = {}) {
    const result = await this.query(`
      INSERT INTO contacts (account_id, phone, name, email, tags, custom_fields, opted_in, opted_in_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (account_id, phone) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, contacts.name),
        email = COALESCE(EXCLUDED.email, contacts.email),
        tags = COALESCE(EXCLUDED.tags, contacts.tags),
        custom_fields = COALESCE(EXCLUDED.custom_fields, contacts.custom_fields),
        opted_in = COALESCE(EXCLUDED.opted_in, contacts.opted_in)
      RETURNING *
    `, [accountId, phone, data.name || null, data.email || null, JSON.stringify(data.tags || []), JSON.stringify(data.customFields || {}), data.optedIn || false, data.optedIn ? new Date() : null]);
    return result.rows[0];
  }

  async getContacts(accountId, { limit = 100, offset = 0, tag = null, search = null } = {}) {
    let sql = 'SELECT * FROM contacts WHERE account_id = $1';
    const params = [accountId];
    let paramIdx = 2;
    if (tag) {
      sql += ` AND tags @> $${paramIdx}::jsonb`;
      params.push(JSON.stringify([tag]));
      paramIdx++;
    }
    if (search) {
      sql += ` AND (phone ILIKE $${paramIdx} OR name ILIKE $${paramIdx})`;
      params.push(`%${search}%`);
      paramIdx++;
    }
    sql += ` ORDER BY last_message_at DESC NULLS LAST LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    params.push(limit, offset);
    return this.all(sql, params);
  }

  async importContacts(accountId, contacts) {
    let imported = 0;
    for (const c of contacts) {
      try {
        await this.upsertContact(accountId, c.phone, c);
        imported++;
      } catch (e) {
        console.error(`Erro ao importar contato ${c.phone}:`, e.message);
      }
    }
    return imported;
  }

  async updateContactLastMessage(accountId, phone) {
    return this.query('UPDATE contacts SET last_message_at = NOW() WHERE account_id = $1 AND phone = $2', [accountId, phone]);
  }

  async saveMessage(data) {
    const result = await this.query(`
      INSERT INTO messages (account_id, meta_message_id, contact_phone, direction, type, content, template_name, status, campaign_id, cost_category)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [data.accountId, data.metaMessageId || null, data.contactPhone, data.direction, data.type, JSON.stringify(data.content || {}), data.templateName || null, data.status || 'sent', data.campaignId || null, data.costCategory || null]);
    return result.rows[0];
  }

  async updateMessageStatus(metaMessageId, status, errorMessage = null) {
    return this.query(
      'UPDATE messages SET status = $1, error_message = $2 WHERE meta_message_id = $3',
      [status, errorMessage, metaMessageId]
    );
  }

  async getMessages(accountId, contactPhone, limit = 50) {
    return this.all(
      'SELECT * FROM messages WHERE account_id = $1 AND contact_phone = $2 ORDER BY created_at DESC LIMIT $3',
      [accountId, contactPhone, limit]
    );
  }

  async createCampaign(accountId, data) {
    const result = await this.query(`
      INSERT INTO campaigns (account_id, name, template_name, template_language, template_variables, target_contacts, target_tags, total_contacts, delay_ms, status, scheduled_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [accountId, data.name, data.templateName, data.templateLanguage || 'pt_BR', JSON.stringify(data.templateVariables || {}), JSON.stringify(data.targetContacts || []), JSON.stringify(data.targetTags || []), data.totalContacts || 0, data.delayMs || 1000, data.scheduledAt ? 'scheduled' : 'draft', data.scheduledAt || null]);
    return result.rows[0];
  }

  async getCampaigns(accountId) {
    return this.all('SELECT * FROM campaigns WHERE account_id = $1 ORDER BY created_at DESC', [accountId]);
  }

  async getCampaignById(campaignId) {
    return this.get('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
  }

  async updateCampaignStatus(campaignId, status) {
    const extra = status === 'running' ? ', started_at = NOW()' : status === 'completed' ? ', completed_at = NOW()' : '';
    return this.query(`UPDATE campaigns SET status = $1${extra} WHERE id = $2`, [status, campaignId]);
  }

  async incrementCampaignCount(campaignId, field) {
    return this.query(`UPDATE campaigns SET ${field} = ${field} + 1 WHERE id = $1`, [campaignId]);
  }

  async getAutoReplies(accountId) {
    return this.all('SELECT * FROM auto_replies WHERE account_id = $1 AND is_active = true ORDER BY priority DESC', [accountId]);
  }

  async createAutoReply(accountId, data) {
    const result = await this.query(`
      INSERT INTO auto_replies (account_id, trigger_type, trigger_value, response_type, response_content, priority)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `, [accountId, data.triggerType, data.triggerValue, data.responseType || 'text', JSON.stringify(data.responseContent), data.priority || 0]);
    return result.rows[0];
  }

  async getClientWebhooks(accountId) {
    return this.all('SELECT * FROM client_webhooks WHERE account_id = $1 AND is_active = true', [accountId]);
  }

  async createClientWebhook(accountId, url, events, secret) {
    const result = await this.query(
      'INSERT INTO client_webhooks (account_id, url, events, secret) VALUES ($1, $2, $3, $4) RETURNING *',
      [accountId, url, JSON.stringify(events), secret || null]
    );
    return result.rows[0];
  }

  async getAccountStats(accountId) {
    const [contacts, messages, campaigns] = await Promise.all([
      this.get('SELECT COUNT(*) as count FROM contacts WHERE account_id = $1', [accountId]),
      this.get(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE direction = 'outgoing' AND status = 'sent') as sent,
          COUNT(*) FILTER (WHERE direction = 'outgoing' AND status = 'delivered') as delivered,
          COUNT(*) FILTER (WHERE direction = 'outgoing' AND status = 'read') as read,
          COUNT(*) FILTER (WHERE direction = 'outgoing' AND status = 'failed') as failed,
          COUNT(*) FILTER (WHERE direction = 'incoming') as received
        FROM messages WHERE account_id = $1 AND created_at > NOW() - INTERVAL '30 days'
      `, [accountId]),
      this.get('SELECT COUNT(*) as total FROM campaigns WHERE account_id = $1', [accountId])
    ]);
    return { contacts: contacts.count, messages, campaigns: campaigns.count };
  }
}

module.exports = Database;
