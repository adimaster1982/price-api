// Transport-independent ticket logic: takes a normalized group message,
// updates the store, and returns what should be sent back to the group.
import { STATUS_HE, PRIORITY_HE } from './db.js';

const PRIORITY_ICON = { urgent: '🔴', normal: '🟡', low: '⚪' };

export function formatDuration(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d) return `${d} ימים ${h} שעות`;
  if (h) return `${h}:${String(m).padStart(2, '0')} שעות`;
  return `${m} דקות`;
}

export function ticketShort(t) {
  const who = t.assignee ? ` · ${t.assignee}` : '';
  const age = formatDuration(Date.now() - Date.parse(t.created_at));
  return `${PRIORITY_ICON[t.priority] || ''} #${t.id} ${t.machine ? t.machine + ' – ' : ''}${t.title} (${STATUS_HE[t.status]}${who}, ${age})`;
}

export function formatOpenList(tickets) {
  if (!tickets.length) return '✅ אין קריאות פתוחות.';
  return `📋 קריאות פתוחות (${tickets.length}):\n` + tickets.map(ticketShort).join('\n');
}

export const HELP_TEXT = `🤖 בוט האחזקה
• לפתיחת קריאה – פשוט כתבו את התקלה (למשל: "מכונה 7 דולפת שמן, עצרה ייצור").
• לעדכון – ענו (Reply) להודעת הבוט או להודעה המקורית, או כתבו #מספר.
• לסגירה – ענו "תוקן" / "סגור".
• פקודות: !פתוחות · !קריאה 12 · !סגור 12 · !עזרה
• אפשר גם לשאול: "מה פתוח על מכונה 12?"`;

export function createAgent({ store, classify, logger = console, recentSize = 8 }) {
  const recent = [];

  function remember(sender, text) {
    if (!text) return;
    recent.push({ sender, text: text.slice(0, 300) });
    while (recent.length > recentSize) recent.shift();
  }

  function activeTicket(id) {
    const t = id ? store.getTicket(id) : null;
    return t && t.status !== 'closed' ? t : null;
  }

  function attachMedia(ticketId, msg) {
    if (!msg.media?.path) return;
    store.addEvent(ticketId, 'media', msg.sender, msg.media.kind === 'audio' ? '🎤 הודעה קולית' : '📷 תמונה', msg.media.path);
  }

  function closeTicket(ticket, author, note, msgId) {
    if (note) store.addEvent(ticket.id, 'update', author, note);
    const closed = store.updateTicket(ticket.id, { status: 'closed' }, author);
    store.linkMessage(msgId, ticket.id);
    const took = formatDuration(Date.parse(closed.closed_at) - Date.parse(closed.created_at));
    return {
      type: 'reply',
      quoteId: msgId,
      ticketId: ticket.id,
      text: `✅ קריאה #${ticket.id} נסגרה${ticket.machine ? ` (${ticket.machine})` : ''} · זמן טיפול: ${took}`,
    };
  }

  /**
   * msg: { id, text, sender, senderPhone, quotedId, media: {kind, path} | null }
   * returns: array of { type: 'reply', text, quoteId, ticketId? } | { type: 'react', emoji, msgId }
   */
  async function handleMessage(msg) {
    const text = (msg.text || '').trim();
    const quotedTicket = store.ticketForMessage(msg.quotedId);
    const hashMatch = text.match(/#(\d{1,6})/);
    const hintedTicket = quotedTicket || (hashMatch ? Number(hashMatch[1]) : null);

    // 1. Media with no caption: attach to the replied ticket or the sender's latest one.
    if (!text) {
      if (!msg.media) return [];
      const target = activeTicket(quotedTicket) || store.lastTicketBy(msg.senderPhone, 15);
      if (!target) return [];
      attachMedia(target.id, msg);
      store.linkMessage(msg.id, target.id);
      return [{ type: 'react', emoji: '📎', msgId: msg.id }];
    }

    // 2. Deterministic commands.
    if (/^!(פתוחות|open)(?=\s|$)/i.test(text)) {
      return [{ type: 'reply', quoteId: msg.id, text: formatOpenList(store.openTickets()) }];
    }
    if (/^!(עזרה|help)(?=\s|$)/i.test(text)) {
      return [{ type: 'reply', quoteId: msg.id, text: HELP_TEXT }];
    }
    const showCmd = text.match(/^!(?:קריאה|ticket)\s*#?(\d+)/i);
    if (showCmd) {
      const t = store.getTicket(Number(showCmd[1]));
      if (!t) return [{ type: 'reply', quoteId: msg.id, text: `לא נמצאה קריאה #${showCmd[1]}` }];
      const hist = store.events(t.id).slice(-8).map((e) => `• ${e.created_at.slice(5, 16).replace('T', ' ')} ${e.author}: ${e.text}`).join('\n');
      return [{ type: 'reply', quoteId: msg.id, ticketId: t.id, text: `${ticketShort(t)}\n${hist}` }];
    }
    const closeCmd = text.match(/^!(?:סגור|close)\s*#?(\d+)/i);
    if (closeCmd) {
      const t = activeTicket(Number(closeCmd[1]));
      if (!t) return [{ type: 'reply', quoteId: msg.id, text: `לא נמצאה קריאה פתוחה #${closeCmd[1]}` }];
      return [closeTicket(t, msg.sender, '', msg.id)];
    }

    // 3. Let Claude interpret the message.
    const decision = await classify({
      text: msg.media ? `${text} [מצורפת ${msg.media.kind === 'audio' ? 'הקלטה' : 'תמונה'}]` : text,
      sender: msg.sender,
      replyToTicket: activeTicket(hintedTicket)?.id || null,
      openTickets: store.openTickets(),
      recent,
    });
    remember(msg.sender, text);
    logger.info?.(`[agent] ${msg.sender}: "${text.slice(0, 60)}" -> ${decision.action} #${decision.ticket_id || '-'}`);

    if (decision.action === 'ignore') return [];

    if (decision.action === 'query') {
      return decision.reply ? [{ type: 'reply', quoteId: msg.id, text: decision.reply }] : [];
    }

    if (decision.action === 'new_ticket') {
      const t = store.createTicket({
        title: decision.title || text.slice(0, 80),
        machine: decision.machine,
        priority: decision.priority,
        assignee: decision.assignee,
        reporter: msg.sender,
        reporterPhone: msg.senderPhone,
      });
      store.addEvent(t.id, 'message', msg.sender, text);
      attachMedia(t.id, msg);
      store.linkMessage(msg.id, t.id);
      return [
        {
          type: 'reply',
          quoteId: msg.id,
          ticketId: t.id,
          text:
            `🆕 נפתחה קריאה #${t.id}\n` +
            `${t.machine ? `ציוד: ${t.machine}\n` : ''}` +
            `תקלה: ${t.title}\n` +
            `דחיפות: ${PRIORITY_ICON[t.priority]} ${PRIORITY_HE[t.priority]}` +
            `${t.assignee ? `\nאחראי: ${t.assignee}` : ''}\n` +
            `לעדכון/סגירה – ענו (Reply) להודעה זו.`,
        },
      ];
    }

    // update / status_change / close need an existing active ticket.
    const ticket = activeTicket(decision.ticket_id) || activeTicket(hintedTicket);
    if (!ticket) {
      logger.warn?.(`[agent] ${decision.action} without a matching open ticket – skipped`);
      return [];
    }
    attachMedia(ticket.id, msg);

    if (decision.action === 'close') {
      return [closeTicket(ticket, msg.sender, decision.note || text, msg.id)];
    }

    store.addEvent(ticket.id, 'update', msg.sender, decision.note || text);
    store.linkMessage(msg.id, ticket.id);

    if (decision.action === 'status_change') {
      const updated = store.updateTicket(
        ticket.id,
        { status: decision.new_status || 'in_progress', assignee: decision.assignee || undefined },
        msg.sender
      );
      return [
        {
          type: 'reply',
          quoteId: msg.id,
          ticketId: ticket.id,
          text: `🔧 קריאה #${ticket.id} → ${STATUS_HE[updated.status]}${updated.assignee ? ` · ${updated.assignee}` : ''}`,
        },
      ];
    }

    // plain update
    if (decision.assignee) store.updateTicket(ticket.id, { assignee: decision.assignee }, msg.sender);
    return [{ type: 'react', emoji: '👍', msgId: msg.id }];
  }

  return { handleMessage };
}
