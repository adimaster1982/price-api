import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { STATUS_HE } from './db.js';
import { formatDuration } from './agent.js';
import { analyze, handlerOf } from './analysis.js';
import { CATEGORIES, OTHER, CATEGORY_LABEL } from './categories.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function createWeb({ store, config, wa, getGroupId, setGroupId, logger = console }) {
  const app = express();
  app.use(express.json());

  // Basic auth on everything except the health check.
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (!config.dashboardPass) return res.status(500).send('DASHBOARD_PASS is not set');
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const [user, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
      if (safeEqual(user, config.dashboardUser) && safeEqual(rest.join(':'), config.dashboardPass)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="maintenance"').status(401).send('Authentication required');
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(express.static(path.join(here, '..', 'public')));
  app.use('/media', express.static(wa.mediaDir, { fallthrough: false }));

  app.get('/api/status', (_req, res) => {
    res.json({ connected: wa.state.connected, needsQr: !!wa.state.qrDataUrl, pairingCode: wa.state.pairingCode, me: wa.state.me?.id || null, groupId: getGroupId() });
  });

  app.get('/api/qr', (_req, res) => res.json({ qr: wa.state.qrDataUrl }));

  app.get('/api/groups', async (_req, res) => {
    try {
      res.json(await wa.listGroups());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/group', (req, res) => {
    const id = String(req.body?.id || '');
    if (!id.endsWith('@g.us')) return res.status(400).json({ error: 'invalid group id' });
    setGroupId(id);
    res.json({ ok: true });
  });

  app.get('/api/tickets', (req, res) => res.json(store.listTickets({ status: req.query.status })));

  app.get('/api/tickets/:id', (req, res) => {
    const t = store.getTicket(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json({ ...t, events: store.events(t.id) });
  });

  app.patch('/api/tickets/:id', async (req, res) => {
    const before = store.getTicket(req.params.id);
    if (!before) return res.status(404).json({ error: 'not found' });
    const { title, machine, priority, status, assignee, category, announce } = req.body || {};
    const t = store.updateTicket(before.id, { title, machine, priority, status, assignee, category }, 'לוח בקרה');
    const groupId = getGroupId();
    if (config.groupFeedback === 'messages' && announce !== false && groupId && status && status !== before.status) {
      const msg =
        status === 'closed'
          ? `✅ קריאה #${t.id} נסגרה מלוח הבקרה · זמן טיפול: ${formatDuration(Date.parse(t.closed_at) - Date.parse(t.created_at))}`
          : `🔧 קריאה #${t.id} → ${STATUS_HE[t.status]}${t.assignee ? ` · ${t.assignee}` : ''}`;
      try {
        const sentId = await wa.sendText(groupId, msg);
        store.linkMessage(sentId, t.id);
      } catch (e) {
        logger.warn('[web] could not announce to group:', e.message);
      }
    }
    res.json(t);
  });

  app.post('/api/tickets', (req, res) => {
    const { title, machine, priority, assignee } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    res.json(store.createTicket({ title, machine, priority, assignee, reporter: 'לוח בקרה' }));
  });

  app.delete('/api/tickets/:id', (req, res) => {
    const t = store.deleteTicket(req.params.id, 'לוח בקרה', String(req.body?.reason || ''));
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(t);
  });

  app.post('/api/tickets/:id/restore', (req, res) => {
    const t = store.restoreTicket(req.params.id, 'לוח בקרה');
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(t);
  });

  app.post('/api/tickets/:id/notes', (req, res) => {
    const t = store.getTicket(req.params.id);
    if (!t || !req.body?.text) return res.status(400).json({ error: 'bad request' });
    store.addEvent(t.id, 'note', req.body.author || 'לוח בקרה', String(req.body.text));
    res.json({ ok: true });
  });

  app.get('/api/unrecognized', (req, res) => res.json(store.listUnrecognized({ lang: req.query.lang })));

  // CSV for Excel (UTF-8 BOM so Hebrew/Russian display correctly).
  app.get('/export/unrecognized.csv', (req, res) => {
    const rows = store.listUnrecognized({ lang: req.query.lang, limit: 100000 });
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['תאריך,שולח,שפה,תמונה,הודעה', ...rows.map((r) => [r.created_at.slice(0, 16).replace('T', ' '), r.sender, r.lang, r.has_media ? 'כן' : '', r.text].map(q).join(','))].join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="unrecognized.csv"').send('\uFEFF' + csv);
  });

  app.get('/api/categories', (_req, res) => res.json([...CATEGORIES, OTHER].map(({ key, label }) => ({ key, label }))));

  app.get('/api/analysis', (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 730);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    res.json(analyze(store.ticketsSince(since), { days, category: String(req.query.category || '') }));
  });

  // All tickets as CSV for Excel (management reports).
  app.get('/export/tickets.csv', (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 365, 1), 3650);
    const rows = store.ticketsSince(new Date(Date.now() - days * 86_400_000).toISOString());
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const fmt = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');
    const hours = (t) => (t.closed_at ? ((Date.parse(t.closed_at) - Date.parse(t.created_at)) / 3_600_000).toFixed(2) : '');
    const head = 'מספר,מכונה,סוג תקלה,תקלה,דחיפות,סטטוס,דיווח,טיפל,נפתחה,נסגרה,זמן תיקון (שעות)';
    const lines = rows.map((t) =>
      [t.id, t.machine, CATEGORY_LABEL[t.category] || 'אחר', t.title, t.priority, STATUS_HE[t.status], t.reporter, handlerOf(t), fmt(t.created_at), fmt(t.closed_at), hours(t)].map(q).join(',')
    );
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="tickets.csv"').send('\uFEFF' + [head, ...lines].join('\r\n'));
  });

  app.get('/api/stats', (req, res) => res.json(store.stats(Number(req.query.days) || 30)));

  return app;
}
