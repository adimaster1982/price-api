// WhatsApp connection via Baileys (unofficial WhatsApp Web protocol).
// Use a DEDICATED number: unofficial clients can be banned by WhatsApp.
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';

function unwrap(message) {
  // ephemeral / view-once / edited wrappers
  let m = message || {};
  for (let i = 0; i < 4; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message ||
      m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

function extract(m) {
  const ctx =
    m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo ||
    m.audioMessage?.contextInfo || m.documentMessage?.contextInfo || null;
  const text =
    m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption ||
    m.documentMessage?.caption || '';
  let mediaKind = null;
  if (m.imageMessage) mediaKind = 'image';
  else if (m.audioMessage) mediaKind = 'audio';
  else if (m.videoMessage) mediaKind = 'video';
  else if (m.documentMessage) mediaKind = 'document';
  return { text, quotedId: ctx?.stanzaId || null, mediaKind };
}

const EXT = { image: 'jpg', audio: 'ogg', video: 'mp4', document: 'bin' };

export function startWhatsApp({ dataDir, pairingPhone = '', getGroupId, onMessage, onConnected = () => {}, logger = console }) {
  const authDir = path.join(dataDir, 'wa-auth');
  const mediaDir = path.join(dataDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const state = { sock: null, connected: false, qrDataUrl: null, pairingCode: null, me: null };
  const waLogger = pino({ level: 'warn' });

  async function connect() {
    const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      auth,
      version,
      logger: waLogger,
      // Must be a recognised browser name: WhatsApp rejects code-pairing for unknown client types.
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    state.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    // Diagnostics for code-pairing: log which fields WhatsApp sent back.
    sock.ws.on('CB:notification,type:link_code_companion_reg', (node) => {
      const reg = Array.isArray(node.content) ? node.content.find((c) => c.tag === 'link_code_companion_reg') : null;
      const tags = Array.isArray(reg?.content) ? reg.content.map((c) => c.tag).join(',') : '';
      logger.info(`[wa] pairing reply: stage=${reg?.attrs?.stage || '?'} fields=${tags || '-'}`);
    });

    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        if (pairingPhone) {
          if (!state.pairingCode) {
            state.pairingCode = await sock.requestPairingCode(pairingPhone);
            logger.info(`[wa] PAIRING CODE: ${state.pairingCode}  (WhatsApp → Linked devices → Link a device → Link with phone number instead)`);
          }
        } else {
          state.qrDataUrl = await QRCode.toDataURL(u.qr);
          logger.info('[wa] scan this QR (WhatsApp → Linked devices → Link a device), or open the dashboard:');
          logger.info(await QRCode.toString(u.qr, { type: 'terminal', small: true }));
        }
      }
      if (u.connection === 'open') {
        state.connected = true;
        state.qrDataUrl = null;
        state.pairingCode = null;
        state.me = sock.user;
        logger.info(`[wa] connected as ${sock.user?.id}`);
        setTimeout(() => Promise.resolve(onConnected()).catch((e) => logger.error('[wa] onConnected failed', e)), 3000);
      }
      if (u.connection === 'close') {
        state.connected = false;
        state.pairingCode = null;
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          logger.error('[wa] logged out – deleting session; scan the QR again');
          fs.rmSync(authDir, { recursive: true, force: true });
        } else {
          logger.warn(`[wa] connection closed (${code}) – reconnecting`);
        }
        setTimeout(() => connect().catch((e) => logger.error('[wa] reconnect failed', e)), 3000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const groupId = getGroupId();
      for (const raw of messages) {
        try {
          if (!raw.message || raw.key.fromMe) continue;
          if (!groupId) {
            logger.warn('[wa] message ignored: no group selected yet – choose the group in the dashboard');
            continue;
          }
          if (raw.key.remoteJid !== groupId) continue;
          const m = unwrap(raw.message);
          const { text, quotedId, mediaKind } = extract(m);

          let media = null;
          if (mediaKind === 'image' || mediaKind === 'audio') {
            const buf = await downloadMediaMessage({ ...raw, message: m }, 'buffer', {}, {
              logger: waLogger,
              reuploadRequest: sock.updateMediaMessage,
            });
            const file = `${raw.key.id}.${EXT[mediaKind]}`;
            fs.writeFileSync(path.join(mediaDir, file), buf);
            media = { kind: mediaKind, path: file };
          }
          if (!text && !media) continue;

          const participant = raw.key.participantAlt?.endsWith('@s.whatsapp.net')
            ? raw.key.participantAlt
            : raw.key.participant || '';
          const senderPhone = participant.endsWith('@s.whatsapp.net') ? participant.split('@')[0].split(':')[0] : participant;

          await onMessage({
            id: raw.key.id,
            key: raw.key,
            raw,
            text,
            quotedId,
            media,
            sender: raw.pushName || senderPhone || 'לא ידוע',
            senderPhone,
          });
        } catch (err) {
          logger.error('[wa] failed handling message', err);
        }
      }
    });
  }

  async function sendText(jid, text, quoted) {
    if (!state.sock || !state.connected) throw new Error('WhatsApp not connected');
    const sent = await state.sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
    return sent?.key?.id || null;
  }

  async function react(jid, key, emoji) {
    if (!state.sock || !state.connected) return;
    await state.sock.sendMessage(jid, { react: { text: emoji, key } });
  }

  async function listGroups() {
    if (!state.sock || !state.connected) return [];
    const groups = await state.sock.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({ id: g.id, name: g.subject, size: g.participants?.length || 0 }));
  }

  connect().catch((e) => logger.error('[wa] initial connect failed', e));

  return { state, sendText, react, listGroups, mediaDir };
}
