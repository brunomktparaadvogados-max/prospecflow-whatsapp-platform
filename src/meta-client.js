const axios = require('axios');

const API_VERSION = 'v21.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

class MetaClient {
  constructor(accessToken, phoneNumberId) {
    this.accessToken = accessToken;
    this.phoneNumberId = phoneNumberId;
    this.http = axios.create({
      baseURL: BASE_URL,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
  }

  async sendText(to, text, previewUrl = false) {
    return this._send(to, {
      type: 'text',
      text: { body: text, preview_url: previewUrl }
    });
  }

  async sendTemplate(to, templateName, language = 'pt_BR', components = []) {
    return this._send(to, {
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        components: components.length > 0 ? components : undefined
      }
    });
  }

  async sendImage(to, imageUrl, caption = '') {
    return this._send(to, {
      type: 'image',
      image: { link: imageUrl, caption: caption || undefined }
    });
  }

  async sendDocument(to, documentUrl, filename = 'document.pdf', caption = '') {
    return this._send(to, {
      type: 'document',
      document: { link: documentUrl, filename, caption: caption || undefined }
    });
  }

  async sendVideo(to, videoUrl, caption = '') {
    return this._send(to, {
      type: 'video',
      video: { link: videoUrl, caption: caption || undefined }
    });
  }

  async sendAudio(to, audioUrl) {
    return this._send(to, {
      type: 'audio',
      audio: { link: audioUrl }
    });
  }

  async sendLocation(to, latitude, longitude, name = '', address = '') {
    return this._send(to, {
      type: 'location',
      location: { latitude, longitude, name, address }
    });
  }

  async sendButtons(to, bodyText, buttons, headerText = '', footerText = '') {
    const interactive = {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((btn, i) => ({
          type: 'reply',
          reply: { id: btn.id || `btn_${i}`, title: btn.title }
        }))
      }
    };
    if (headerText) interactive.header = { type: 'text', text: headerText };
    if (footerText) interactive.footer = { text: footerText };
    return this._send(to, { type: 'interactive', interactive });
  }

  async sendList(to, bodyText, buttonText, sections, headerText = '', footerText = '') {
    const interactive = {
      type: 'list',
      body: { text: bodyText },
      action: { button: buttonText, sections }
    };
    if (headerText) interactive.header = { type: 'text', text: headerText };
    if (footerText) interactive.footer = { text: footerText };
    return this._send(to, { type: 'interactive', interactive });
  }

  async markAsRead(messageId) {
    try {
      await this.http.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      });
      return { success: true };
    } catch (error) {
      return this._handleError(error);
    }
  }

  async sendReaction(to, messageId, emoji) {
    return this._send(to, {
      type: 'reaction',
      reaction: { message_id: messageId, emoji }
    });
  }

  async getTemplates(wabaId, limit = 100) {
    try {
      const response = await this.http.get(`/${wabaId}/message_templates`, { params: { limit } });
      return { success: true, templates: response.data.data || [] };
    } catch (error) {
      return this._handleError(error);
    }
  }

  async createTemplate(wabaId, templateData) {
    try {
      const response = await this.http.post(`/${wabaId}/message_templates`, templateData);
      return { success: true, template: response.data };
    } catch (error) {
      return this._handleError(error);
    }
  }

  async deleteTemplate(wabaId, templateName) {
    try {
      await this.http.delete(`/${wabaId}/message_templates`, { params: { name: templateName } });
      return { success: true };
    } catch (error) {
      return this._handleError(error);
    }
  }

  async getPhoneNumberInfo() {
    try {
      const response = await this.http.get(`/${this.phoneNumberId}`, {
        params: { fields: 'display_phone_number,verified_name,quality_rating,messaging_limit_tier,code_verification_status,platform_type,throughput,status' }
      });
      return { success: true, info: response.data };
    } catch (error) {
      return this._handleError(error);
    }
  }

  async getBusinessInfo(wabaId) {
    try {
      const response = await this.http.get(`/${wabaId}`, {
        params: { fields: 'name,currency,timezone_id,message_template_namespace' }
      });
      return { success: true, info: response.data };
    } catch (error) {
      return this._handleError(error);
    }
  }

  async validateToken() {
    try {
      const response = await this.http.get(`/${this.phoneNumberId}`, {
        params: { fields: 'display_phone_number,verified_name' }
      });
      return {
        success: true, valid: true,
        phoneNumber: response.data.display_phone_number,
        verifiedName: response.data.verified_name
      };
    } catch (error) {
      if (error.response?.status === 401 || error.response?.data?.error?.code === 190) {
        return { success: false, valid: false, error: 'Token de acesso invalido ou expirado' };
      }
      return this._handleError(error);
    }
  }

  async getMediaUrl(mediaId) {
    try {
      const response = await this.http.get(`/${mediaId}`);
      return { success: true, url: response.data.url, mimeType: response.data.mime_type };
    } catch (error) {
      return this._handleError(error);
    }
  }

  async uploadMedia(filePath, mimeType) {
    try {
      const FormData = require('form-data');
      const fs = require('fs');
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('file', fs.createReadStream(filePath));
      form.append('type', mimeType);
      const response = await axios.post(
        `${BASE_URL}/${this.phoneNumberId}/media`, form,
        { headers: { ...form.getHeaders(), 'Authorization': `Bearer ${this.accessToken}` } }
      );
      return { success: true, mediaId: response.data.id };
    } catch (error) {
      return this._handleError(error);
    }
  }

  async _send(to, messageData) {
    try {
      const normalizedTo = to.replace(/\\D/g, '');
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizedTo,
        ...messageData
      };
      const response = await this.http.post(`/${this.phoneNumberId}/messages`, payload);
      return {
        success: true,
        messageId: response.data.messages?.[0]?.id,
        contacts: response.data.contacts,
        raw: response.data
      };
    } catch (error) {
      return this._handleError(error);
    }
  }

  _handleError(error) {
    const metaError = error.response?.data?.error;
    if (metaError) {
      return {
        success: false,
        error: metaError.message,
        errorCode: metaError.code,
        errorSubcode: metaError.error_subcode,
        errorType: metaError.type,
        details: metaError.error_data?.details || null,
        friendlyError: this._translateError(metaError.code, metaError.error_subcode, metaError.message)
      };
    }
    return {
      success: false,
      error: error.message,
      friendlyError: 'Erro de conexao com a API da Meta. Verifique sua internet e tente novamente.'
    };
  }

  _translateError(code, subcode, originalMessage) {
    const errors = {
      '190': 'Token de acesso invalido ou expirado. Gere um novo token no Meta Business Suite.',
      '100': 'Parametro invalido na requisicao. Verifique o numero de telefone e o formato da mensagem.',
      '131047': 'Mensagem nao enviada: o contato nao tem WhatsApp neste numero.',
      '131026': 'Mensagem nao enviada: o contato nao aceitou receber mensagens (opt-in necessario).',
      '131051': 'Tipo de mensagem nao suportado.',
      '131053': 'Midia muito grande ou formato nao suportado.',
      '130429': 'Limite de envio atingido. Aguarde antes de enviar mais mensagens.',
      '131031': 'Conta nao verificada. Complete a verificacao no Meta Business Suite.',
      '132000': 'Template nao encontrado ou nao aprovado. Verifique o nome e idioma do template.',
      '132001': 'Variaveis do template incorretas. Verifique os parametros enviados.',
      '132005': 'Template pausado pela Meta por baixa qualidade. Revise o conteudo.',
      '132007': 'Template desativado. Crie um novo template.',
      '132012': 'Numero de parametros do template incorreto.',
      '133010': 'Numero do WhatsApp Business nao registrado ou desconectado.',
      '133015': 'Limite de mensagens do plano atingido. Atualize seu tier no Meta Business Suite.',
      '368': 'Conta temporariamente bloqueada por violacao de politicas. Verifique no Meta Business Suite.'
    };
    return errors[String(code)] || errors[String(subcode)] || `Erro da Meta API: ${originalMessage}`;
  }
}

module.exports = MetaClient;
