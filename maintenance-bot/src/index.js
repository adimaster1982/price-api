import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';
import { openDb } from './db.js';
import { createClassifier } from './classifier.js';
import { createRulesClassifier } from './rules-classifier.js';
import { createAgent, WELCOME_TEXT, privateCommand } from './agent.js';
import { startWhatsApp } from './whatsapp.js';
import { startScheduler } from './scheduler.js';
import { createWeb } from './web.js';

const logger = console;
fs.mkdirSync(config.dataDir, { recursive: true });

const store = openDb(path.join(config.dataDir, 'maintenance.db'));
const getGroupId = () => store.getSetting('group_id', config.groupId);
const setGroupId = (id) => {
  store.setSetting('group_id', id);
  sendWelcomeOnce().catch((e) => logger.error('[agent] welcome failed', e.message));
};

// Post the "how to open a ticket" instructions the first time the bot is active in a group.
async function sendWelcomeOnce() {
  const groupId = getGroupId();
  if (!groupId || !wa?.state.connected || store.getSetting(`welcomed:${groupId}`)) return;
  await wa.sendText(groupId, WELCOME_TEXT);
  store.setSetting(`welcomed:${groupId}`, new Date().toISOString());
  logger.info('[agent] welcome instructions posted to the group');
}

const classify =
  config.classifier === 'claude' ? createClassifier({ model: config.model, logger }) : createRulesClassifier();
logger.info(`[agent] classifier: ${config.classifier === 'claude' ? `Claude (${config.model})` : 'offline rules'}`);
const agent = createAgent({ store, classify, logger, feedback: config.groupFeedback, listReply: config.listReply });

// Keep recent raw messages so replies can quote them.
const rawById = new Map();

const wa = startWhatsApp({
  onConnected: sendWelcomeOnce,
  dataDir: config.dataDir,
  pairingPhone: config.pairingPhone,
  getGroupId,
  logger,
  // Private chat: read-only commands, answered only to members of the maintenance group.
  onPrivate: async ({ jid, altJid, text, sender }) => {
    const reply = privateCommand(store, text);
    if (!reply) return;
    if (!(await wa.isGroupMember(getGroupId(), [jid, altJid]))) {
      logger.warn(`[wa] private command from non-member ${sender || jid} ignored`);
      return;
    }
    logger.info(`[wa] private ${sender}: ${text.slice(0, 40)}`);
    await wa.sendText(jid, reply);
  },
  onMessage: async (msg) => {
    logger.info(`[wa] ${new Date().toLocaleTimeString('he-IL')} ${msg.sender}: ${(msg.text || (msg.media ? `[${msg.media.kind}]` : '')).slice(0, 60)}`);
    rawById.set(msg.id, msg.raw);
    if (rawById.size > 500) rawById.delete(rawById.keys().next().value);

    const actions = await agent.handleMessage(msg);
    const groupId = getGroupId();
    for (const a of actions) {
      if (a.type === 'private') {
        await wa.sendText(msg.senderJid, a.text).catch((e) => logger.error('[wa] private reply failed', e.message));
      } else if (a.type === 'react') {
        await wa.react(groupId, msg.key, a.emoji);
      } else if (a.type === 'reply') {
        const sentId = await wa.sendText(groupId, a.text, rawById.get(a.quoteId));
        if (a.ticketId) store.linkMessage(sentId, a.ticketId);
      }
    }
  },
});

startScheduler({ store, config, wa, getGroupId, logger });

createWeb({ store, config, wa, getGroupId, setGroupId, logger }).listen(config.port, () => {
  logger.info(`[web] dashboard: http://localhost:${config.port}`);
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family === 'IPv4' && !a.internal) logger.info(`[web] from another device on this network: http://${a.address}:${config.port}`);
      }
    }
  } catch {
    // Some Android versions do not allow listing network interfaces.
  }
  if (!config.dashboardPass) logger.warn('[web] DASHBOARD_PASS is not set – dashboard is locked');
});
