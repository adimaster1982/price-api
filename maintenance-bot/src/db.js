import { DatabaseSync } from 'node:sqlite';
import { categorize } from './categories.js';
import { detectEquipment } from './equipment.js';

export const STATUSES = ['open', 'in_progress', 'waiting_parts', 'closed'];
export const PRIORITIES = ['low', 'normal', 'urgent'];

export const STATUS_HE = {
  open: 'פתוחה',
  in_progress: 'בטיפול',
  waiting_parts: 'ממתינה לחלק',
  closed: 'סגורה',
};
export const PRIORITY_HE = { low: 'נמוכה', normal: 'רגילה', urgent: 'דחופה' };

const now = () => new Date().toISOString();

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tickets (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      title          TEXT NOT NULL,
      machine        TEXT NOT NULL DEFAULT '',
      priority       TEXT NOT NULL DEFAULT 'normal',
      status         TEXT NOT NULL DEFAULT 'open',
      assignee       TEXT NOT NULL DEFAULT '',
      reporter       TEXT NOT NULL DEFAULT '',
      reporter_phone TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      closed_at      TEXT,
      escalated_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id  INTEGER NOT NULL REFERENCES tickets(id),
      type       TEXT NOT NULL,
      author     TEXT NOT NULL DEFAULT '',
      text       TEXT NOT NULL DEFAULT '',
      media_path TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_ticket ON events(ticket_id);
    CREATE TABLE IF NOT EXISTS msg_links (
      msg_id    TEXT PRIMARY KEY,
      ticket_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS unrecognized (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
      sender     TEXT NOT NULL DEFAULT '',
      lang       TEXT NOT NULL DEFAULT 'he',
      has_media  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS equipment (
      type        TEXT NOT NULL,
      number      TEXT NOT NULL,
      sku         TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      grp         TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (type, number, sku)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Migrations for databases created by earlier versions.
  const cols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
  if (!cols.includes('category')) db.exec(`ALTER TABLE tickets ADD COLUMN category TEXT NOT NULL DEFAULT ''`);
  if (!cols.includes('closed_by')) db.exec(`ALTER TABLE tickets ADD COLUMN closed_by TEXT NOT NULL DEFAULT ''`);
  if (!cols.includes('deleted_at')) db.exec(`ALTER TABLE tickets ADD COLUMN deleted_at TEXT`);
  for (const c of ['eq_type', 'eq_number', 'eq_sku', 'eq_desc']) {
    if (!cols.includes(c)) db.exec(`ALTER TABLE tickets ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`);
  }
  const store = new Store(db);
  store.backfillCategories();
  store.backfillEquipment();
  return store;
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  // ---- settings ----
  getSetting(key, fallback = '') {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }
  setSetting(key, value) {
    this.db
      .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  // ---- tickets ----
  createTicket({ title, machine = '', priority = 'normal', assignee = '', reporter = '', reporterPhone = '', category = '', eqType = '', eqNumber = '' }) {
    const t = now();
    const pr = PRIORITIES.includes(priority) ? priority : 'normal';
    const cat = category || categorize(title);
    const res = this.db
      .prepare(
        `INSERT INTO tickets(title, machine, priority, assignee, reporter, reporter_phone, created_at, updated_at, category)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(title, machine, pr, assignee, reporter, reporterPhone, t, t, cat);
    const id = Number(res.lastInsertRowid);
    if (eqType) this.setTicketEquipment(id, eqType, eqNumber);
    this.addEvent(id, 'created', reporter, title);
    return this.getTicket(id);
  }

  getTicket(id) {
    return this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(id)) || null;
  }

  listTickets({ status } = {}) {
    if (status === 'active') {
      return this.db
        .prepare(
          `SELECT * FROM tickets WHERE status != 'closed' AND deleted_at IS NULL
           ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at`
        )
        .all();
    }
    if (status === 'deleted') {
      return this.db.prepare('SELECT * FROM tickets WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500').all();
    }
    if (status && STATUSES.includes(status)) {
      return this.db.prepare('SELECT * FROM tickets WHERE status = ? AND deleted_at IS NULL ORDER BY updated_at DESC').all(status);
    }
    return this.db.prepare('SELECT * FROM tickets WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 500').all();
  }

  openTickets() {
    return this.listTickets({ status: 'active' });
  }

  updateTicket(id, fields, author = '') {
    const ticket = this.getTicket(id);
    if (!ticket) return null;
    const allowed = ['title', 'machine', 'priority', 'status', 'assignee', 'category'];
    const changes = [];
    for (const key of allowed) {
      if (fields[key] === undefined || fields[key] === null) continue;
      let value = String(fields[key]).trim();
      if (key === 'status' && !STATUSES.includes(value)) continue;
      if (key === 'priority' && !PRIORITIES.includes(value)) continue;
      if (value === ticket[key]) continue;
      changes.push([key, value]);
    }
    if (!changes.length) return ticket;

    const t = now();
    const sets = changes.map(([k]) => `${k} = ?`).join(', ');
    const values = changes.map(([, v]) => v);
    let extra = '';
    const status = changes.find(([k]) => k === 'status')?.[1];
    // Who closed it: the WhatsApp sender; a dashboard close keeps the assignee as the handler.
    const closer = author && !author.startsWith('לוח בקרה') ? author : '';
    if (status === 'closed') extra = ', closed_at = ?, closed_by = ?';
    else if (status) extra = ", closed_at = NULL, escalated_at = NULL, closed_by = ''";
    const params = [...values, t, ...(status === 'closed' ? [t, closer] : []), Number(id)];
    this.db.prepare(`UPDATE tickets SET ${sets}, updated_at = ?${extra} WHERE id = ?`).run(...params);

    for (const [k, v] of changes) {
      const label =
        k === 'status' ? `סטטוס: ${STATUS_HE[v]}` : k === 'priority' ? `דחיפות: ${PRIORITY_HE[v]}` : k === 'assignee' ? `אחראי: ${v}` : k === 'category' ? `סוג תקלה: ${v}` : `${k}: ${v}`;
      this.addEvent(id, k === 'status' ? 'status' : 'change', author, label);
    }
    return this.getTicket(id);
  }

  // Give a category to tickets created before categories existed (title + first message).
  backfillCategories() {
    const rows = this.db.prepare(`SELECT id, title FROM tickets WHERE category = ''`).all();
    for (const r of rows) {
      const first = this.db.prepare(`SELECT text FROM events WHERE ticket_id = ? AND type = 'message' ORDER BY id LIMIT 1`).get(r.id);
      this.db.prepare('UPDATE tickets SET category = ? WHERE id = ?').run(categorize(`${r.title} ${first?.text || ''}`), r.id);
    }
  }

  // Tickets opened before equipment detection existed: detect the equipment from title + first message.
  backfillEquipment() {
    const rows = this.db.prepare(`SELECT id, title, machine FROM tickets WHERE eq_type = ''`).all();
    for (const r of rows) {
      const first = this.db.prepare(`SELECT text FROM events WHERE ticket_id = ? AND type = 'message' ORDER BY id LIMIT 1`).get(r.id);
      const eq = detectEquipment(`${r.title} ${first?.text || ''}`, r.machine);
      if (eq.type) this.setTicketEquipment(r.id, eq.type, eq.number);
    }
  }

  /** All tickets opened since the given ISO time (for the analysis screen). */
  ticketsSince(sinceIso) {
    return this.db.prepare('SELECT * FROM tickets WHERE created_at >= ? AND deleted_at IS NULL ORDER BY created_at').all(sinceIso);
  }

  // ---- equipment (imported from the factory equipment report) ----
  replaceEquipment(items) {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM equipment');
      const ins = this.db.prepare('INSERT OR REPLACE INTO equipment(type, number, sku, description, grp) VALUES(?, ?, ?, ?, ?)');
      for (const e of items) ins.run(e.type, e.number, e.sku, e.description, e.group || '');
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.setSetting('equipment_imported_at', now());
    // Re-link existing tickets to the new list.
    for (const t of this.db.prepare(`SELECT id, eq_type, eq_number FROM tickets WHERE eq_type != ''`).all()) {
      this.setTicketEquipment(t.id, t.eq_type, t.eq_number);
    }
  }

  listEquipment() {
    return this.db.prepare('SELECT * FROM equipment ORDER BY type, CAST(number AS INTEGER)').all();
  }

  findEquipment(type, number) {
    if (!type || !number) return null;
    return this.db.prepare('SELECT * FROM equipment WHERE type = ? AND number = ? LIMIT 1').get(type, String(Number(number))) || null;
  }

  /** Link a ticket to equipment; fills SKU + description when the item is in the list. */
  setTicketEquipment(id, type, number) {
    const num = number ? String(Number(number)) : '';
    const e = this.findEquipment(type, num);
    this.db
      .prepare('UPDATE tickets SET eq_type = ?, eq_number = ?, eq_sku = ?, eq_desc = ? WHERE id = ?')
      .run(type || '', num, e?.sku || '', e?.description || '', Number(id));
    return e;
  }

  /** "Not a real ticket": hidden from lists, reports and the bot, but kept so it can be restored. */
  deleteTicket(id, author = '', reason = '') {
    if (!this.getTicket(id)) return null;
    this.db.prepare('UPDATE tickets SET deleted_at = ? WHERE id = ?').run(now(), Number(id));
    this.addEvent(id, 'deleted', author, `נמחקה – לא רלוונטית${reason ? `: ${reason}` : ''}`);
    return this.getTicket(id);
  }

  restoreTicket(id, author = '') {
    if (!this.getTicket(id)) return null;
    this.db.prepare('UPDATE tickets SET deleted_at = NULL WHERE id = ?').run(Number(id));
    this.addEvent(id, 'restored', author, 'שוחזרה');
    return this.getTicket(id);
  }

  markEscalated(id) {
    this.db.prepare('UPDATE tickets SET escalated_at = ? WHERE id = ?').run(now(), Number(id));
  }

  // ---- events ----
  addEvent(ticketId, type, author, text, mediaPath = null) {
    this.db
      .prepare('INSERT INTO events(ticket_id, type, author, text, media_path, created_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(Number(ticketId), type, author || '', text || '', mediaPath, now());
    this.db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now(), Number(ticketId));
  }

  events(ticketId) {
    return this.db.prepare('SELECT * FROM events WHERE ticket_id = ? ORDER BY id').all(Number(ticketId));
  }

  // ---- message <-> ticket links ----
  linkMessage(msgId, ticketId) {
    if (!msgId) return;
    this.db
      .prepare('INSERT INTO msg_links(msg_id, ticket_id) VALUES(?, ?) ON CONFLICT(msg_id) DO UPDATE SET ticket_id = excluded.ticket_id')
      .run(msgId, Number(ticketId));
  }

  ticketForMessage(msgId) {
    if (!msgId) return null;
    const row = this.db.prepare('SELECT ticket_id FROM msg_links WHERE msg_id = ?').get(msgId);
    return row ? row.ticket_id : null;
  }

  lastTicketBy(phone, withinMinutes) {
    const since = new Date(Date.now() - withinMinutes * 60_000).toISOString();
    return (
      this.db
        .prepare(`SELECT * FROM tickets WHERE reporter_phone = ? AND created_at >= ? AND status != 'closed' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`)
        .get(phone, since) || null
    );
  }

  // ---- messages the bot did not turn into a ticket (for tuning / future Russian support) ----
  addUnrecognized(text, sender, hasMedia = false) {
    const lang = /[\u0400-\u04FF]/.test(text) ? 'ru' : 'he';
    this.db
      .prepare('INSERT INTO unrecognized(text, sender, lang, has_media, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(text, sender || '', lang, hasMedia ? 1 : 0, now());
  }

  listUnrecognized({ lang, limit = 1000 } = {}) {
    return lang
      ? this.db.prepare('SELECT * FROM unrecognized WHERE lang = ? ORDER BY id DESC LIMIT ?').all(lang, limit)
      : this.db.prepare('SELECT * FROM unrecognized ORDER BY id DESC LIMIT ?').all(limit);
  }

  // ---- stats ----
  stats(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM tickets WHERE deleted_at IS NULL GROUP BY status').all()) byStatus[r.status] = r.n;
    const opened = this.db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE created_at >= ? AND deleted_at IS NULL').get(since).n;
    const closedRows = this.db
      .prepare('SELECT created_at, closed_at FROM tickets WHERE closed_at IS NOT NULL AND closed_at >= ? AND deleted_at IS NULL')
      .all(since);
    const mttrHours = closedRows.length
      ? closedRows.reduce((s, r) => s + (Date.parse(r.closed_at) - Date.parse(r.created_at)), 0) / closedRows.length / 3_600_000
      : null;
    const topMachines = this.db
      .prepare(
        `SELECT machine, COUNT(*) AS n FROM tickets WHERE machine != '' AND created_at >= ? AND deleted_at IS NULL
         GROUP BY machine ORDER BY n DESC LIMIT 5`
      )
      .all(since);
    return { days, byStatus, opened, closed: closedRows.length, mttrHours, topMachines };
  }
}
