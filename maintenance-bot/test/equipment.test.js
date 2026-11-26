import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEquipmentRows, detectEquipment } from '../src/equipment.js';
import { openDb } from '../src/db.js';
import { createAgent } from '../src/agent.js';
import { createRulesClassifier } from '../src/rules-classifier.js';

// Same shape as the factory report (made-up SKUs).
const ROWS = [
  ['קבוצת ציוד', 'ציוד', 'תיאור ציוד', 'מספר ציוד ברביב'],
  ['Injection Machines', 'EIM-T339', 'מכונת הזרקה 339', '339'],
  ['robots', 'ERT-T339', 'רובוט על מכונה 339', '339'],
  ['dryer', 'EDR-T704', 'ייבשן 704,705', '704,705'],
  ['dryer', 'EGN-T000', 'מקט פיקטיבי', '-1'],
  ['color dispensers', 'EDS-T021', "ממנן צבע מס' 21", '21'],
  ['heaters for molds', 'E-T107', 'מחמם תבניות', '107'],
  ['chillers', 'EGN-T087', 'צילר 130 טון קירור TRANE מספר1', '0'],
];

test('parse the equipment report: types, multi-number rows, skip 0/-1', () => {
  const items = parseEquipmentRows(ROWS);
  assert.deepEqual(items.map((i) => `${i.type}:${i.number}`), ['injection:339', 'robot:339', 'dryer:704', 'dryer:705', 'color:21', 'heater:107', 'chiller:1']);
});

test('detect equipment from messages', () => {
  assert.deepEqual(detectEquipment('תנור 705 לא מחמם', 'מכונה 705'), { type: 'dryer', number: '705' });
  assert.deepEqual(detectEquipment("ממנן צבע מס' 21 לא עובד"), { type: 'color', number: '21' });
  assert.deepEqual(detectEquipment('ממנן במכונה 339 תקוע', 'מכונה 339'), { type: 'color', number: '' });
  assert.deepEqual(detectEquipment('339 מפילה מוצרים', 'מכונה 339'), { type: 'robot', number: '339' });
  assert.deepEqual(detectEquipment('תקלה בשסתום 447', 'מכונה 447'), { type: 'injection', number: '447' });
});

test('new ticket gets SKU + description from the list; unknown items are flagged', async () => {
  const store = openDb(':memory:');
  store.replaceEquipment(parseEquipmentRows(ROWS));
  const agent = createAgent({ store, classify: createRulesClassifier(), logger: { info() {}, warn() {}, error() {} } });
  const m = (id, text) => ({ id, text, sender: 'יוסי', senderPhone: '1', quotedId: null, media: null });
  await agent.handleMessage(m('1', 'תנור 705 לא מחמם'));
  let t = store.getTicket(1);
  assert.equal(t.eq_type, 'dryer'); assert.equal(t.eq_number, '705'); assert.equal(t.eq_sku, 'EDR-T704');
  assert.equal(t.machine, 'מייבש 705');
  await agent.handleMessage(m('2', '339 מפילה מוצרים'));
  t = store.getTicket(2);
  assert.equal(t.eq_type, 'robot'); assert.equal(t.eq_sku, 'ERT-T339'); assert.equal(t.machine, 'מכונה 339');
  await agent.handleMessage(m('3', 'תקלה בשסתום 512 מכונה נעצרת'));
  t = store.getTicket(3);
  assert.equal(t.eq_type, 'injection'); assert.equal(t.eq_number, '512'); assert.equal(t.eq_sku, '', 'not in the list');
  // Re-importing re-links existing tickets.
  store.replaceEquipment(parseEquipmentRows([...ROWS, ['Injection Machines', 'EIM-T512', 'מכונה 512', '512']]));
  assert.equal(store.getTicket(3).eq_sku, 'EIM-T512');
});

test('tickets opened before the equipment feature are linked on start and on import', () => {
  const store = openDb(':memory:');
  store.db.prepare(`INSERT INTO tickets(title, machine, created_at, updated_at) VALUES('339 מפילה מוצרים', 'מכונה 339', '2026-11-20T08:00:00Z', '2026-11-20T08:00:00Z')`).run();
  store.backfillEquipment();
  assert.equal(store.getTicket(1).eq_type, 'robot');
  assert.equal(store.getTicket(1).eq_sku, '');
  store.replaceEquipment(parseEquipmentRows(ROWS));
  assert.equal(store.getTicket(1).eq_sku, 'ERT-T339');
});

test('update and close by equipment type + 2-digit number', async () => {
  const store = openDb(':memory:');
  store.replaceEquipment(parseEquipmentRows(ROWS));
  const agent = createAgent({ store, classify: createRulesClassifier(), logger: { info() {}, warn() {}, error() {} } });
  const m = (id, text, phone) => ({ id, text, sender: 'x', senderPhone: phone, quotedId: null, media: null });
  await agent.handleMessage(m('1', "ממנן צבע מס' 21 לא עובד", '1'));
  assert.equal(store.getTicket(1).priority, 'normal');
  await agent.handleMessage(m('2', 'ממנן 21 אני בדרך', '2'));
  assert.equal(store.getTicket(1).status, 'in_progress');
  await agent.handleMessage(m('3', 'ממנן 21 תוקן', '2'));
  assert.equal(store.getTicket(1).status, 'closed');
});
