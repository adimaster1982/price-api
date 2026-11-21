// Offline classifier: keyword/regex rules in Hebrew. No network, no AI service.
// Returns the same decision shape as the Claude classifier.
import { IGNORE } from './classifier.js';
import { formatOpenList } from './agent.js';

const has = (re, s) => re.test(s);

// Words are matched as substrings, so stems cover inflections (עצר/עצרה/עוצרת).
const CLOSE = /(תוקן|תוקנה|תיקנתי|תיקנו|סגור|נסגר|לסגור|סיימתי|סיימנו|בוצע|טופל|טופלה|הסתדר|חזר[הו]? לעבוד|עובד(ת)? (שוב|תקין|כרגיל)|עובד(ת)?$|תקין|✅|👍)/;
const WAITING = /(ממתינ|ממתין|מחכה|מחכים|הוזמן|הזמנתי|הזמנו|להזמין|חלק חילוף|ספק|חסר חלק|אין חלק)/;
const PROGRESS = /(מטפל|בטיפול|בדרך|אני על זה|לוקח את|לקחתי|מתחיל|התחלתי|הגעתי|אגיע|עובד על זה|בודק)/;
const FIRST_PERSON = /(^|\s)(אני|אנחנו|לקחתי|הגעתי|אגיע|התחלתי|הזמנתי|תיקנתי|סיימתי|בודק|מטפל)(\s|$)/;
const FAULT = /(תקלה|שרוף|שרופ|מקולקל|לא תקין|לא דולק|כבה|כבוי|חסום|סתום|לא יורד|לא עולה|תקול|לא עובד|לא עובדת|לא נדלק|לא נדלקת|נתקע|תקוע|דולף|דולפת|דליפ|נוזל|שבור|נשבר|נשברה|עצר|עוצר|עומדת|עומד|רעש|חם מדי|מתחמם|לא מקרר|לא מחמם|קצר|שריפ|עשן|ריח שרוף|אזעקה|התראה|alarm|error|שגיאה|לא תופס|לא סוגר|לא פותח|בעיה|לתקן|צריך טכנאי|צריך חשמלאי|קפץ|נפל|נפלה|סדוק|נקרע|לחץ נמוך|לחץ גבוה|ברז|פיצוץ)/i;
const URGENT = /(עצר|עוצר|עומדת|עומד|דחוף|מיידי|מייד|שריפ|עשן|קצר|חשמל|דליפ|דולף|בטיחות|סכנה|פציע|נפגע|השבת|ייצור עומד|קו עומד)/;
const LOW = /(לא דחוף|כשיתפנה|כשיהיה זמן|נורה|ניקיון|צבע|שלט|קוסמטי)/;
const NEW_HINT = /(עוד תקלה|תקלה נוספת|תקלה חדשה|בעיה נוספת|בנוסף)/;
const QUERY = /^(\?|מה (פתוח|המצב|הסטטוס)|יש (משהו )?פתוח|כמה (קריאות )?פתוח|מה עם|מי מטפל|איפה עומד)/;

const EQUIPMENT = [
  "צ'ילר", 'צילר', 'צ׳ילר', 'מדחס', 'קומפרסור', 'מייבש', 'רובוט', 'מסוע', 'תבנית', 'מגרסה', 'טוחנת',
  'מנוף', 'מלגזה', 'מזגן', 'גנרטור', 'משאבה', 'לוח חשמל', 'מערבל', 'מטען', 'דוזר', 'ווקום', 'מגדל קירור',
];
const BRANDS = ['Engel', 'Arburg', 'KraussMaffei', 'Krauss', 'Haitian', 'Battenfeld', 'Sumitomo', 'Demag', 'Husky', 'Netstal', 'Wittmann', 'Yushin', 'Sepro', 'Negri Bossi', 'Boy', 'Fanuc'];

export function extractMachine(text) {
  let m = text.match(/(?:מכונה|מכונת|מכונות|מכ'|מ')\s*(?:מס(?:פר|'|׳)?\s*)?#?\s*(\d{1,3})/);
  if (m) return `מכונה ${m[1]}`;
  for (const b of BRANDS) {
    m = text.match(new RegExp(`\\b${b}\\s*#?(\\d{1,3})?`, 'i'));
    if (m) return m[1] ? `${b} ${m[1]}` : b;
  }
  for (const e of EQUIPMENT) {
    const i = text.indexOf(e);
    if (i >= 0) {
      const num = text.slice(i + e.length).match(/^\s*#?(\d{1,3})/);
      return num ? `${e} ${num[1]}` : e;
    }
  }
  return '';
}

const norm = (s) => s.replace(/[׳']/g, "'").replace(/\s+/g, ' ').trim();
const sameMachine = (a, b) => a && b && norm(a).replace(/צילר/, "צ'ילר") === norm(b).replace(/צילר/, "צ'ילר");

function makeTitle(text) {
  const clean = text.replace(/#\d+/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > 70 ? clean.slice(0, 67) + '…' : clean;
}

export function createRulesClassifier() {
  return async function classify({ text, sender, replyToTicket, openTickets }) {
    const t = text.replace(/\[מצורפת [^\]]+\]/, '').trim();
    const machine = extractMachine(t);
    const assignee = FIRST_PERSON.test(t) ? sender : '';
    const base = { ...IGNORE, machine, assignee };

    // Questions about the ticket list.
    if (QUERY.test(t)) {
      const list = machine ? openTickets.filter((x) => sameMachine(x.machine, machine)) : openTickets;
      return { ...base, action: 'query', reply: machine && !list.length ? `אין קריאות פתוחות על ${machine}.` : formatOpenList(list) };
    }

    // Which existing ticket is this about?
    let ticketId = replyToTicket || 0;
    if (!ticketId && machine && !NEW_HINT.test(t)) {
      const match = openTickets.filter((x) => sameMachine(x.machine, machine));
      if (match.length === 1) ticketId = match[0].id;
    }

    if (ticketId) {
      // A reply that clearly reports a different machine's fault is a new ticket.
      const target = openTickets.find((x) => x.id === ticketId);
      const otherMachine = machine && target?.machine && !sameMachine(machine, target.machine);
      if (!(otherMachine && has(FAULT, t))) {
        const note = makeTitle(t);
        if (has(CLOSE, t) && !has(/לא (תוקן|עובד|תקין)|עדיין/, t)) return { ...base, action: 'close', ticket_id: ticketId, note };
        if (has(WAITING, t)) return { ...base, action: 'status_change', ticket_id: ticketId, new_status: 'waiting_parts', note };
        if (has(PROGRESS, t)) return { ...base, action: 'status_change', ticket_id: ticketId, new_status: 'in_progress', assignee: assignee || '', note };
        return { ...base, action: 'update', ticket_id: ticketId, note };
      }
    }

    if (has(FAULT, t) && t.length >= 6) {
      const priority = has(/לא דחוף|כשיתפנה|כשיהיה זמן/, t) ? 'low' : has(URGENT, t) ? 'urgent' : has(LOW, t) ? 'low' : 'normal';
      return { ...base, action: 'new_ticket', title: makeTitle(t), priority, assignee: '' };
    }

    return { ...IGNORE };
  };
}
