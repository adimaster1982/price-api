import cron from 'node-cron';
import { formatOpenList, formatDuration, ticketShort } from './agent.js';

export function buildDailySummary(store) {
  const open = store.openTickets();
  const s = store.stats(1);
  const lines = [`☀️ דוח בוקר – אחזקה`];
  lines.push(`ב-24 שעות אחרונות: נפתחו ${s.opened} · נסגרו ${s.closed}` + (s.mttrHours != null ? ` · זמן טיפול ממוצע ${formatDuration(s.mttrHours * 3_600_000)}` : ''));
  lines.push('');
  lines.push(formatOpenList(open, { withHelp: true }));
  return lines.join('\n');
}

export function findEscalations(store, { urgentHours, normalHours, now = Date.now() }) {
  return store.openTickets().filter((t) => {
    if (t.escalated_at || t.priority === 'low') return false;
    const limit = (t.priority === 'urgent' ? urgentHours : normalHours) * 3_600_000;
    return now - Date.parse(t.created_at) >= limit;
  });
}

export function startScheduler({ store, config, wa, getGroupId, logger = console }) {
  const opts = { timezone: config.timezone };

  const summaryOn = config.dailySummaryCron && config.dailySummaryCron !== 'off';
  if (summaryOn) cron.schedule(config.dailySummaryCron, async () => {
    const groupId = getGroupId();
    if (!groupId) return;
    try {
      await wa.sendText(groupId, buildDailySummary(store));
    } catch (e) {
      logger.error('[cron] daily summary failed', e.message);
    }
  }, opts);

  cron.schedule(config.escalationCron, async () => {
    if (!config.managerPhones.length) return;
    const due = findEscalations(store, { urgentHours: config.urgentEscalateHours, normalHours: config.normalEscalateHours });
    for (const t of due) {
      const text = `⚠️ הסלמה: קריאה פתוחה מעל הזמן המוגדר\n${ticketShort(t)}` + (config.publicUrl ? `\n${config.publicUrl}` : '');
      try {
        for (const phone of config.managerPhones) await wa.sendText(`${phone}@s.whatsapp.net`, text);
        store.markEscalated(t.id);
      } catch (e) {
        logger.error('[cron] escalation failed', e.message);
      }
    }
  }, opts);
}
