// Offline classifier: keyword/regex rules in Hebrew. No network, no AI service.
// Returns the same decision shape as the Claude classifier.
import { IGNORE } from './classifier.js';
import { formatOpenList } from './agent.js';
import { detectEquipment } from './equipment.js';

const has = (re, s) => re.test(s);

// Words are matched as substrings, so stems cover inflections (עצר/עצרה/עוצרת).
const CLOSE = /(תוקן|תוקנה|תיקנתי|תיקנו|סגור|נסגר|לסגור|סיימתי|סיימנו|בוצע|טופל|טופלה|הסתדר|חזר[הו]? לעבוד|עובד(ת)? (שוב|תקין|כרגיל)|עובד(ת)?$|תקין|✅|👍)/;
const WAITING = /(ממתינ|ממתין|מחכה|מחכים|הוזמן|הזמנתי|הזמנו|להזמין|חלק חילוף|ספק|חסר חלק|אין חלק)/;
const PROGRESS = /(מטפל|בטיפול|בדרך|אני על זה|לוקח את|לקחתי|מתחיל|התחלתי|הגעתי|אגיע|עובד על זה|בודק)/;
const FIRST_PERSON = /(^|\s)(אני|אנחנו|לקחתי|הגעתי|אגיע|התחלתי|הזמנתי|תיקנתי|סיימתי|בודק|מטפל)(\s|$)/;
const FAULT = /(תקלה|שרוף|שרופ|מקולקל|לא תקין|לא דולק|כבה|כבוי|חסום|סתום|לא יורד|לא עולה|תקול|לא עובד|לא עובדת|לא נדלק|לא נדלקת|נתקע|תקוע|דולף|דולפת|דליפ|נוזל|שבור|נשבר|נשברה|עצר|עוצר|עומדת|עומד|רעש|חם מדי|מתחמם|לא מקרר|לא מחמם|קצר|שריפ|עשן|ריח שרוף|אזעקה|התראה|alarm|error|שגיאה|לא תופס|לא סוגר|לא פותח|בעיה|לתקן|צריך טכנאי|צריך חשמלאי|קפץ|נפל|נפלה|נופל|מפיל|נופלות|סדוק|זורק|לא מוציא|לא שולף|לא מוריד|לא משחרר|משתחרר|רופף|מטפטף|טפטוף|נזיל|רנר|ראנר|ספרו|runner|sprue|גריפר|תפסנית|ואקום|וקום|הוט ראנר|hot runner|פלאש|flash|שורט|short|חסר מילוי|בועות|שקיעות|עיוות|נקודות שחורות|חוטים|פין שבור|פינים|נקרע|לחץ נמוך|לחץ גבוה|ברז|פיצוץ)/i;
const URGENT = /(עצר|עוצר|עומדת|עומד|דחוף|מיידי|מייד|שריפ|עשן|קצר|חשמל|דליפ|דולף|בטיחות|סכנה|פציע|נפגע|השבת|ייצור עומד|קו עומד)/;
const LOW = /(לא דחוף|כשיתפנה|כשיהיה זמן|נורה|ניקיון|שלט|קוסמטי)/;
const NEW_HINT = /(עוד תקלה|תקלה נוספת|תקלה חדשה|בעיה נוספת|בנוסף)/;
// Phrases that contain a fault word but mean the opposite ("no problem").
const NOT_FAULT = /(אין בעיה|אין בעיות|בלי בעיה|לא בעיה|אין תקלה|אין תקלות|ללא תקלות)/g;
const QUERY = /^(\?|מה (פתוח|המצב|הסטטוס)|יש (משהו )?פתוח|כמה (קריאות )?פתוח|מה עם|מי מטפל|איפה עומד)/;

// Words that mean the problem is in the robot / take-out (runner, sprue, gripper, vacuum).
const ROBOT_HINT = /(רנר|ראנר|ספרו|runner|sprue|גריפר|תפסנית|ואקום|וקום|לא שולף|לא מוציא|מפיל|מוצרים נופלים|נופלים מוצרים)/i;
// A request to do something on a machine ("please check 339", "no air gauge on 667, please fit one").
const REQUEST = /(תבדקו|תבדוק|לבדוק|בבקשה ל|צריך ל|להחליף|להתקין|לשים|לתקן|אין שעון|^אין |\. ?אין |חסר )/;

const EQUIPMENT = [
  "צ'ילר", 'צילר', 'צ׳ילר', 'מדחס', 'קומפרסור', 'מייבש', 'רובוט', 'מסוע', 'תבנית', 'מגרסה', 'טוחנת',
  'מנוף', 'מלגזה', 'מזגן', 'גנרטור', 'משאבה', 'לוח חשמל', 'מערבל', 'מטען', 'דוזר', 'ווקום', 'מגדל קירור',
  'תפסנית', 'גריפר', 'הוט ראנר', 'בקר טמפרטורה', 'מחמם תבנית', 'מזין', 'יבשן', 'שסתום', 'שעון אוויר',
];
const BRANDS = ['Engel', 'Arburg', 'KraussMaffei', 'Krauss', 'Haitian', 'Battenfeld', 'Sumitomo', 'Demag', 'Husky', 'Netstal', 'Wittmann', 'Yushin', 'Sepro', 'Negri Bossi', 'Boy', 'Fanuc'];

export function extractMachine(text) {
  for (const b of BRANDS) {
    const m = text.match(new RegExp(`\\b${b}\\s*#?(\\d{1,3})?`, 'i'));
    if (m) return m[1] ? `${b} ${m[1]}` : b;
  }
  const nums = [];
  // "מכונה 7", "ממכונה 460", "מכ' 3"
  for (const m of text.matchAll(/(?:מכונה|מכונת|מכונות|מכ'|מ')\s*(?:מס(?:פר|'|׳)?\s*)?#?\s*(\d{1,4})/g)) nums.push(m[1]);
  // The team usually writes just the machine number, always 3 digits: "339 מפילה", "124 + 555", "ב667"
  if (!nums.length) {
    for (const m of text.matchAll(/(?<![\d#:.\/])(?:^|(?<=[\s(,+\-–בלמוה]))(\d{3})(?![\d:%\/]|\.\d)/g)) nums.push(m[1]);
  }
  const unique = [...new Set(nums)];
  if (unique.length === 1) return `מכונה ${unique[0]}`;
  if (unique.length > 1) return `מכונות ${unique.join(', ')}`;
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
    const hasMedia = /\[מצורפת [^\]]+\]/.test(text);
    const t = text.replace(/\[מצורפת [^\]]+\]/, '').trim();
    const tf = t.replace(NOT_FAULT, ' ');
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
    // "ממנן 21 תוקן", "תנור 705 בטיפול": match the open ticket of that exact equipment.
    if (!ticketId && !NEW_HINT.test(t)) {
      const eq = detectEquipment(t, machine);
      if (eq.type && eq.type !== 'injection' && eq.number) {
        const match = openTickets.filter((x) => x.eq_type === eq.type && x.eq_number === eq.number);
        if (match.length === 1) ticketId = match[0].id;
      }
    }
    if (!ticketId && machine && !NEW_HINT.test(t)) {
      const nums = machine.match(/\d+/g) || [];
      const match = openTickets.filter(
        (x) => sameMachine(x.machine, machine) || (nums.length && nums.some((n) => (x.machine.match(/\d+/g) || []).includes(n)))
      );
      if (match.length === 1) ticketId = match[0].id;
    }

    if (ticketId) {
      // A reply that clearly reports a different machine's fault is a new ticket.
      const target = openTickets.find((x) => x.id === ticketId);
      const otherMachine = machine && target?.machine && !sameMachine(machine, target.machine);
      if (!(otherMachine && has(FAULT, tf))) {
        const note = makeTitle(t);
        if (has(CLOSE, t) && !has(/לא (תוקן|עובד|תקין)|עדיין|יטופל|יתוקן|לטפל|לתקן/, t)) return { ...base, action: 'close', ticket_id: ticketId, note };
        if (has(WAITING, t)) return { ...base, action: 'status_change', ticket_id: ticketId, new_status: 'waiting_parts', note };
        if (has(PROGRESS, t)) return { ...base, action: 'status_change', ticket_id: ticketId, new_status: 'in_progress', assignee: assignee || '', note };
        return { ...base, action: 'update', ticket_id: ticketId, note };
      }
    }

    // A fault word, or a photo with a machine name (people often just send a picture + "machine 7 ...").
    const photoReport = hasMedia && machine && !has(CLOSE, t) && !QUERY.test(t);
    const machineRequest = machine && has(REQUEST, t);
    if ((has(FAULT, tf) && t.length >= 6) || photoReport || machineRequest) {
      const priority = has(/לא דחוף|כשיתפנה|כשיהיה זמן/, t) ? 'low' : has(URGENT, t) ? 'urgent' : has(LOW, t) ? 'low' : 'normal';
      let title = makeTitle(t);
      if (ROBOT_HINT.test(t) && !/רובוט/.test(t)) title = `רובוט – ${title}`;
      return { ...base, action: 'new_ticket', title, priority, assignee: '' };
    }

    return { ...IGNORE };
  };
}
