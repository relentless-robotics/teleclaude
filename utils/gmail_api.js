const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
const TOKEN_PATH = path.join(__dirname, '../secure/gmail_token.json');
const CREDENTIALS_PATH = path.join(__dirname, '../secure/gmail_credentials.json');

class GmailAPI {
  constructor() {
    this.auth = null;
    this.gmail = null;
  }

  async initialize() {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    this.oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (fs.existsSync(TOKEN_PATH)) {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
      this.oAuth2Client.setCredentials(token);
    } else {
      await this.getNewToken();
    }

    this.gmail = google.gmail({ version: 'v1', auth: this.oAuth2Client });
    return this;
  }

  async getNewToken() {
    const authUrl = this.oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });
    console.log('Authorize this app by visiting:', authUrl);
    // Open browser to authUrl
    const { exec } = require('child_process');
    exec(`start "" "${authUrl}"`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const code = await new Promise(resolve => rl.question('Enter the code from that page here: ', resolve));
    rl.close();

    const { tokens } = await this.oAuth2Client.getToken(code);
    this.oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  }

  async listMessages(query = '', maxResults = 10) {
    const res = await this.gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });
    return res.data.messages || [];
  }

  async getMessage(messageId) {
    const res = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    return this.parseMessage(res.data);
  }

  parseMessage(message) {
    const headers = message.payload.headers;
    const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    let body = '';
    if (message.payload.body.data) {
      body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
    } else if (message.payload.parts) {
      const textPart = message.payload.parts.find(p => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
      }
    }

    return {
      id: message.id,
      threadId: message.threadId,
      from: getHeader('from'),
      to: getHeader('to'),
      subject: getHeader('subject'),
      date: getHeader('date'),
      body,
      snippet: message.snippet,
    };
  }

  async sendEmail(to, subject, body) {
    const message = [
      `To: ${to}`,
      `Subject: ${subject}`,
      '',
      body,
    ].join('\n');

    const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

    const res = await this.gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage },
    });
    return res.data;
  }

  async searchEmails(query, maxResults = 10) {
    const messages = await this.listMessages(query, maxResults);
    const fullMessages = await Promise.all(
      messages.map(m => this.getMessage(m.id))
    );
    return fullMessages;
  }
}

module.exports = { GmailAPI };
