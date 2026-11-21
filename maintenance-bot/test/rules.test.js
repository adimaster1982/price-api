import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRulesClassifier, extractMachine } from '../src/rules-classifier.js';
import { openDb } from '../src/db.js';
import { createAgent } from '../src/agent.js';

const classify = createRulesClassifier();
const open = [
  { id: 4, machine: 'מכונה 7', title: 'דליפת שמן', status: 'open', priority: 'urgent', assignee: '', created_at: new Date().toISOString() },
  { id: 5, machine: "צ'ילר 2", title: 'לא מקרר', status: 'open', priority: 'normal', assignee: '', created_at: new Date().toISOString() },
];
const c = (text, extra = {}) => classify({ text, sender: 'דני', replyToTicket: null, openTickets: open, recent: [], ...extra });

test('machine extraction', () => {
  assert.equal(extractMachine('מכונה 12 עצרה'), 'מכונה 12');
  assert.equal(extractMachine("מכ' 3 דולפת"), 'מכונה 3');
  assert.equal(extractMachine('Engel 4 alarm'), 'Engel 4');
  assert.equal(extractMachine("הצ'ילר 2 לא מקרר"), "צ'ילר 2");
  assert.equal(extractMachine('שלום לכולם'), '');
});

test('new tickets and priority', async () => {
  let d = await c('מכונה 12 עצרה, דולף מים מהתבנית');
  assert.equal(d.action, 'new_ticket'); assert.equal(d.priority, 'urgent'); assert.equal(d.machine, 'מכונה 12');
  d = await c('נורה שרופה באולם B, לא דחוף');
  assert.equal(d.action, 'new_ticket'); assert.equal(d.priority, 'low');
  d = await c('הרובוט במכונה 9 לא תופס מוצר');
  assert.equal(d.action, 'new_ticket'); assert.equal(d.priority, 'normal');
});

test('chit-chat is ignored', async () => {
  for (const t of ['בוקר טוב', 'תודה רבה!', 'מי מגיע מחר למשמרת?']) assert.equal((await c(t)).action, 'ignore', t);
});

test('replies map to update / status / close', async () => {
  assert.equal((await c('תוקן', { replyToTicket: 4 })).action, 'close');
  assert.equal((await c('עדיין לא תוקן', { replyToTicket: 4 })).action, 'update');
  const w = await c('הזמנתי אטם מהספק', { replyToTicket: 4 });
  assert.equal(w.action, 'status_change'); assert.equal(w.new_status, 'waiting_parts'); assert.equal(w.assignee, 'דני');
  const p = await c('אני בדרך', { replyToTicket: 4 });
  assert.equal(p.new_status, 'in_progress'); assert.equal(p.assignee, 'דני');
  assert.equal((await c('החלפתי את הצינור', { replyToTicket: 4 })).action, 'update');
});

test('machine name links to the open ticket without a reply', async () => {
  const d = await c('מכונה 7 תוקנה וחזרה לעבוד');
  assert.equal(d.action, 'close'); assert.equal(d.ticket_id, 4);
  const e = await c('תקלה נוספת במכונה 7 - המסוע נתקע');
  assert.equal(e.action, 'new_ticket');
});

test('reply about a different machine fault opens a new ticket', async () => {
  const d = await c('מכונה 3 גם עצרה', { replyToTicket: 4 });
  assert.equal(d.action, 'new_ticket');
});

test('queries answer from the open list', async () => {
  const d = await c('מה פתוח על מכונה 7?');
  assert.equal(d.action, 'query'); assert.match(d.reply, /#4/); assert.doesNotMatch(d.reply, /#5/);
});

test('end to end with the agent, offline', async () => {
  const store = openDb(':memory:');
  const agent = createAgent({ store, classify, logger: { info() {}, warn() {}, error() {} } });
  const m = (id, text, q = null) => ({ id, text, sender: 'יוסי', senderPhone: '1', quotedId: q, media: null });
  const [a] = await agent.handleMessage(m('1', 'מכונה 7 דולפת שמן, עצרה ייצור'));
  assert.match(a.text, /נפתחה קריאה #1/);
  store.linkMessage('bot', 1);
  await agent.handleMessage(m('2', 'הזמנתי אטם', 'bot'));
  assert.equal(store.getTicket(1).status, 'waiting_parts');
  const [b] = await agent.handleMessage(m('3', '!קריאה 1'));
  assert.match(b.text, /הזמנתי אטם/);
  await agent.handleMessage(m('4', 'תוקן', 'bot'));
  assert.equal(store.getTicket(1).status, 'closed');
});
