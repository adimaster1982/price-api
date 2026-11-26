import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize } from '../src/categories.js';
import { analyze } from '../src/analysis.js';
import { openDb } from '../src/db.js';

test('categories from real factory messages', () => {
  const cases = {
    '111 רנרים במוצרים': 'robot',
    'תבדקו בבקשה 339 מפילה מוצרים': 'robot',
    'תקלה בשסתום 447 מכונה נעצרת פעם שניה': 'hydraulic',
    '444 נזילות יטופל לאחר הורדת תבנית.': 'mold',
    'אין שעון אוויר לVG ב667. בבקשה לשים שעון.': 'pneumatic',
    'יבשן לא תקין ממכונה 460.': 'peripheral',
    'בקר טמפ׳ במכונה 210 לא מחמם': 'peripheral',
    'קצר בלוח חשמל של 305': 'electrical',
    "הצ'ילר לא מקרר": 'cooling',
    'משהו מוזר ב 512': 'other',
  };
  for (const [text, key] of Object.entries(cases)) assert.equal(categorize(text), key, text);
});

test('MTTR, MTBF and downtime per machine', () => {
  const now = Date.parse('2026-11-30T00:00:00Z');
  const iso = (hAgo) => new Date(now - hAgo * 3_600_000).toISOString();
  const tickets = [
    // machine 339: two failures, 2h and 4h repairs
    { machine: 'מכונה 339', category: 'robot', created_at: iso(100), closed_at: iso(98), assignee: 'דני', closed_by: '' },
    { machine: 'מכונה 339', category: 'robot', created_at: iso(50), closed_at: iso(46), assignee: '', closed_by: 'יוסי' },
    // machine 447: one failure still open for 10h
    { machine: 'מכונה 447', category: 'hydraulic', created_at: iso(10), closed_at: null, assignee: '', closed_by: '' },
    // outside the period
    { machine: 'מכונה 339', category: 'robot', created_at: iso(24 * 40), closed_at: iso(24 * 40 - 1), assignee: '', closed_by: '' },
  ];
  const a = analyze(tickets, { days: 30, now });
  const m339 = a.machines.find((m) => m.machine === 'מכונה 339');
  assert.equal(m339.failures, 2);
  assert.equal(m339.mttrHours, 3);
  assert.equal(m339.downtimeHours, 6);
  assert.equal(m339.mtbfHours, (720 - 6) / 2);
  const m447 = a.machines.find((m) => m.machine === 'מכונה 447');
  assert.equal(m447.open, 1);
  assert.equal(m447.mttrHours, null);
  assert.equal(m447.downtimeHours, 10);
  assert.deepEqual(a.handlers.map((h) => [h.name, h.closed]).sort(), [['דני', 1], ['יוסי', 1]]);
  assert.equal(a.categories[0].key, 'robot');
  assert.equal(analyze(tickets, { days: 30, now, category: 'hydraulic' }).total.failures, 1);
});

test('closing from WhatsApp records who closed; old databases get categories', () => {
  const store = openDb(':memory:');
  const t = store.createTicket({ title: '339 מפיל מוצרים', machine: 'מכונה 339' });
  assert.equal(t.category, 'robot');
  store.updateTicket(t.id, { status: 'closed' }, 'יוסי');
  assert.equal(store.getTicket(t.id).closed_by, 'יוסי');
  store.db.prepare(`UPDATE tickets SET category = '' WHERE id = ?`).run(t.id);
  store.backfillCategories();
  assert.equal(store.getTicket(t.id).category, 'robot');
});

test('overlapping tickets on one machine count downtime once', () => {
  const now = Date.parse('2026-11-30T00:00:00Z');
  const iso = (hAgo) => new Date(now - hAgo * 3_600_000).toISOString();
  const a = analyze([
    { machine: 'מכונה 339', created_at: iso(10), closed_at: iso(4) },
    { machine: 'מכונה 339', created_at: iso(8), closed_at: iso(2) },
  ], { days: 30, now });
  assert.equal(a.machines[0].downtimeHours, 8);
  assert.equal(a.machines[0].mtbfHours, (720 - 8) / 2);
});

test('deleted tickets vanish from lists, reports and the bot, and can be restored', () => {
  const store = openDb(':memory:');
  const t = store.createTicket({ title: 'בדיקה 999 לא עובד', machine: 'מכונה 999' });
  store.deleteTicket(t.id, 'לוח בקרה');
  assert.equal(store.openTickets().length, 0);
  assert.equal(store.listTickets().length, 0);
  assert.equal(store.ticketsSince('2000-01-01').length, 0);
  assert.equal(store.listTickets({ status: 'deleted' })[0].id, t.id);
  store.restoreTicket(t.id, 'לוח בקרה');
  assert.equal(store.openTickets().length, 1);
});
