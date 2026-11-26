import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createAgent } from '../src/agent.js';
import { IGNORE, buildUserContent } from '../src/classifier.js';
import { findEscalations, buildDailySummary } from '../src/scheduler.js';

const quiet = { info() {}, warn() {}, error() {} };

function setup(decisions) {
  const store = openDb(':memory:');
  const calls = [];
  const classify = async (input) => {
    calls.push(input);
    return { ...IGNORE, ...(decisions.shift() || {}) };
  };
  return { store, calls, agent: createAgent({ store, classify, logger: quiet, feedback: 'messages' }) };
}

const msg = (id, text, extra = {}) => ({ id, text, sender: 'יוסי', senderPhone: '972500000000', quotedId: null, media: null, ...extra });

test('new ticket -> reply-to-bot update -> close', async () => {
  const { store, agent, calls } = setup([
    { action: 'new_ticket', title: 'דליפת שמן', machine: 'מכונה 7', priority: 'urgent' },
    { action: 'status_change', ticket_id: 1, new_status: 'waiting_parts', assignee: 'דני', note: 'הוזמן אטם' },
    { action: 'close', ticket_id: 1, note: 'הוחלף אטם' },
  ]);

  const [r1] = await agent.handleMessage(msg('m1', 'מכונה 7 דולפת שמן, עצרה'));
  assert.match(r1.text, /נפתחה קריאה #1/);
  assert.equal(store.getTicket(1).priority, 'urgent');
  store.linkMessage('bot1', r1.ticketId); // simulate the sent announcement

  const [r2] = await agent.handleMessage(msg('m2', 'מחכים לאטם', { quotedId: 'bot1' }));
  assert.equal(calls[1].replyToTicket, 1, 'reply to bot message resolves to ticket');
  assert.match(r2.text, /ממתינה לחלק · דני/);

  const [r3] = await agent.handleMessage(msg('m3', 'תוקן', { quotedId: 'm2' }));
  assert.match(r3.text, /קריאה #1 נסגרה/);
  const t = store.getTicket(1);
  assert.equal(t.status, 'closed');
  assert.ok(t.closed_at);
  assert.ok(store.events(1).length >= 5);
});

test('commands work without calling Claude', async () => {
  const { store, agent, calls } = setup([]);
  store.createTicket({ title: 'נורה שרופה', machine: 'אולם B', priority: 'low' });
  const [list] = await agent.handleMessage(msg('a', '!פתוחות'));
  assert.match(list.text, /#1 אולם B/);
  const [closed] = await agent.handleMessage(msg('b', '!סגור 1'));
  assert.match(closed.text, /נסגרה/);
  const [none] = await agent.handleMessage(msg('c', '!סגור 1'));
  assert.match(none.text, /לא נמצאה/);
  assert.equal(calls.length, 0);
});

test('update to unknown ticket is skipped, ignore produces nothing', async () => {
  const { agent } = setup([{ action: 'update', ticket_id: 99 }, { action: 'ignore' }]);
  assert.deepEqual(await agent.handleMessage(msg('x', 'עדכון כלשהו')), []);
  assert.deepEqual(await agent.handleMessage(msg('y', 'תודה!')), []);
});

test('caption-less photo attaches to the sender\'s recent ticket', async () => {
  const { store, agent } = setup([{ action: 'new_ticket', title: 'צ\'ילר 2 לא מקרר', machine: 'צ\'ילר 2' }]);
  await agent.handleMessage(msg('p0', 'הצ\'ילר 2 לא מקרר'));
  const [r] = await agent.handleMessage(msg('p1', '', { media: { kind: 'image', path: 'p1.jpg' } }));
  assert.equal(r.type, 'react');
  assert.ok(store.events(1).some((e) => e.media_path === 'p1.jpg'));
});

test('escalation picks overdue urgent tickets once', () => {
  const store = openDb(':memory:');
  const t = store.createTicket({ title: 'x', priority: 'urgent' });
  store.createTicket({ title: 'y', priority: 'low' });
  const later = Date.now() + 3 * 3_600_000;
  assert.deepEqual(findEscalations(store, { urgentHours: 2, normalHours: 48, now: later }).map((x) => x.id), [t.id]);
  store.markEscalated(t.id);
  assert.equal(findEscalations(store, { urgentHours: 2, normalHours: 48, now: later }).length, 0);
  assert.match(buildDailySummary(store), /קריאות פתוחות \(2\)/);
});

test('classifier prompt includes open tickets and reply hint', () => {
  const s = buildUserContent({ text: 'שלום', sender: 'א', replyToTicket: 3, openTickets: [], recent: [] });
  assert.match(s, /reply_to_ticket: #3/);
  assert.match(s, /\(none\)/);
});

test('caption-less photo: bot asks for details, then attaches the photo to the ticket', async () => {
  const { store, agent } = setup([{ action: 'new_ticket', title: 'מפיל מוצרים', machine: 'מכונה 339' }]);
  const photo = (id) => msg(id, '', { media: { kind: 'image', path: `${id}.jpg` } });
  const [ask] = await agent.handleMessage(photo('ph1'));
  assert.match(ask.text, /מספר המכונה/);
  assert.deepEqual(await agent.handleMessage(photo('ph2')), [], 'asks only once in a row');
  const [r] = await agent.handleMessage(msg('t1', '339 מפיל מוצרים', { quotedId: 'ph1' }));
  assert.match(r.text, /נפתחה קריאה #1/);
  const media = store.events(1).filter((e) => e.media_path).map((e) => e.media_path);
  assert.deepEqual(media, ['ph1.jpg', 'ph2.jpg']);
});

test('ignored messages are kept for review, Russian is tagged', async () => {
  const { store, agent } = setup([{ action: 'ignore' }, { action: 'ignore' }, { action: 'ignore' }]);
  await agent.handleMessage(msg('r1', 'робот роняет детали 339'));
  await agent.handleMessage(msg('r2', 'בוקר טוב'));
  await agent.handleMessage(msg('r3', 'ok'));
  const all = store.listUnrecognized();
  assert.equal(all.length, 2);
  assert.equal(store.listUnrecognized({ lang: 'ru' })[0].text, 'робот роняет детали 339');
});

test('react mode: no text in the group, only emoji reactions', async () => {
  const store = openDb(':memory:');
  const decisions = [
    { action: 'new_ticket', title: 'מפיל מוצרים', machine: 'מכונה 339' },
    { action: 'status_change', ticket_id: 1, new_status: 'waiting_parts' },
    { action: 'close', ticket_id: 1 },
  ];
  const agent = createAgent({ store, classify: async () => ({ ...IGNORE, ...decisions.shift() }), logger: quiet });
  const [a] = await agent.handleMessage(msg('o1', '339 מפיל מוצרים'));
  assert.deepEqual(a, { type: 'react', emoji: '📝', msgId: 'o1' });
  const [b] = await agent.handleMessage(msg('o2', 'הזמנתי גריפר', { quotedId: 'o1' }));
  assert.equal(b.emoji, '⏳');
  const [c] = await agent.handleMessage(msg('o3', 'תוקן', { quotedId: 'o1' }));
  assert.equal(c.emoji, '✅');
  assert.equal(store.getTicket(1).status, 'closed');
  assert.ok(store.getTicket(1).closed_at, 'close time is still recorded for the reports');
});

test('follow-up description joins the reporter\'s ticket; no number = no ticket', async () => {
  const { createRulesClassifier } = await import('../src/rules-classifier.js');
  const store = openDb(':memory:');
  const agent = createAgent({ store, classify: createRulesClassifier(), logger: quiet });
  const m = (id, text, phone = '972500000001', sender = 'יוסי') => ({ id, text, sender, senderPhone: phone, quotedId: null, media: null });

  await agent.handleMessage(m('a1', '452 תקלה במכונה'));
  const [r] = await agent.handleMessage(m('a2', 'הרובוט לא מוציא את החלק מהתבנית'));
  assert.equal(r.emoji, '👍');
  const t = store.getTicket(1);
  assert.equal(store.listTickets().length, 1, 'no second ticket');
  assert.match(t.title, /452 תקלה במכונה – הרובוט לא מוציא/);
  assert.equal(t.eq_type, 'robot'); assert.equal(t.eq_number, '452');
  assert.equal(t.category, 'robot');

  // Someone else writing a fault without a number: nothing opens.
  assert.deepEqual(await agent.handleMessage(m('b1', 'הצ׳ילר לא מקרר', '972500000002', 'משה')), []);
  assert.equal(store.listTickets().length, 1);
  assert.ok(store.listUnrecognized().some((u) => u.text === 'הצ׳ילר לא מקרר'));
});

test('open-tickets report ends with how to answer', async () => {
  const { buildDailySummary } = await import('../src/scheduler.js');
  const store = openDb(':memory:');
  store.createTicket({ title: 'תקלה בשסתום', machine: 'מכונה 447' });
  const text = buildDailySummary(store);
  assert.match(text, /#1 תוקן/);
  assert.match(text, /447 הזמנתי חלק/);
  assert.doesNotMatch(buildDailySummary(openDb(':memory:')), /לעדכון/);
});

test('commands work with "!" at the start, at the end, or without it', async () => {
  const { store, agent, calls } = setup([]);
  store.createTicket({ title: 'תקלה', machine: 'מכונה 447' });
  for (const t of ['קריאות', 'קריאות!', '!קריאות', '\u200fקריאות!', 'פתוחות']) {
    const [r] = await agent.handleMessage(msg('c' + t, t));
    assert.match(r.text, /קריאות פתוחות \(1\)/, t);
  }
  // Default (not the 'messages' test setup): list goes privately + 📩 in the group.
  const priv = createAgent({ store, classify: async () => IGNORE, logger: quiet });
  const [p1, p2] = await priv.handleMessage(msg('pv', 'קריאות'));
  assert.equal(p1.type, 'private'); assert.match(p1.text, /קריאות פתוחות/);
  assert.deepEqual(p2, { type: 'react', emoji: '📩', msgId: 'pv' });
  const { privateCommand } = await import('../src/agent.js');
  assert.match(privateCommand(store, 'קריאות!'), /קריאות פתוחות \(1\)/);
  assert.match(privateCommand(store, 'קריאה 1'), /#1/);
  assert.equal(privateCommand(store, 'סגור 1'), null, 'closing stays in the group');
  const [x] = await agent.handleMessage(msg('k', 'קריאה 1!'));
  assert.match(x.text, /#1/);
  const [y] = await agent.handleMessage(msg('s', 'סגור 1!'));
  assert.match(y.text, /נסגרה/);
  assert.equal(calls.length, 0);
});

test('deleting the opening message in the group deletes the ticket; deleting an update only notes it', async () => {
  const { store, agent } = setup([
    { action: 'new_ticket', title: 'מפיל מוצרים', machine: 'מכונה 339' },
    { action: 'update', ticket_id: 1, note: 'הוחלף גריפר' },
  ]);
  await agent.handleMessage(msg('open1', '339 מפיל מוצרים'));
  await agent.handleMessage(msg('upd1', 'הוחלף גריפר', { quotedId: 'open1' }));
  assert.deepEqual(agent.handleRevoke('upd1'), { noted: 1 });
  assert.equal(store.openTickets().length, 1);
  assert.deepEqual(agent.handleRevoke('open1'), { deleted: 1 });
  assert.equal(store.openTickets().length, 0);
  assert.ok(store.getTicket(1).deleted_at);
  assert.deepEqual(agent.handleRevoke('unknown'), { noted: null });
});
