// Equipment list (from the factory's equipment report) and detection of which
// piece of equipment a WhatsApp message is about.
//
// The report's "מספר ציוד ברביב" repeats across types (111 is a machine, its robot
// and a mold heater), so equipment is identified by TYPE + NUMBER.

export const TYPES = {
  injection: 'מכונת הזרקה',
  robot: 'רובוט',
  dryer: 'מייבש',
  color: 'ממנן צבע',
  chiller: 'צילר',
  heater: 'מחמם תבנית',
};

// Equipment group names in the report -> type.
const GROUP_TO_TYPE = [
  [/injection/i, 'injection'],
  [/robot/i, 'robot'],
  [/dryer/i, 'dryer'],
  [/color|dispens/i, 'color'],
  [/chiller/i, 'chiller'],
  [/heater/i, 'heater'],
];

/** Rows from the report (header + data) -> [{type, number, sku, description, group}] */
export function parseEquipmentRows(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  const col = (re, fallback) => {
    const i = header.findIndex((h) => re.test(h));
    return i >= 0 ? i : fallback;
  };
  const cGroup = col(/קבוצ/, 0);
  const cSku = col(/^ציוד$|מק"?ט/, 1);
  const cDesc = col(/תיאור/, 2);
  const cNum = col(/מספר/, 3);

  const items = [];
  for (const r of rows.slice(1)) {
    const group = r[cGroup] || '';
    const type = GROUP_TO_TYPE.find(([re]) => re.test(group))?.[1];
    if (!type || !r[cSku]) continue;
    // "704,705" covers two numbers; 0 / -1 mean "no number" – then try the description ("צילר ... מספר2").
    let nums = String(r[cNum] || '').split(/[,;/]/).map((x) => x.trim()).filter((n) => /^\d+$/.test(n) && Number(n) > 0);
    if (!nums.length) {
      const d = (r[cDesc] || '').match(/(?:מספר|מס'|#)\s*(\d{1,3})(?!\d)/);
      if (d) nums = [d[1]];
    }
    for (const n of nums) {
      if (/^\d+$/.test(n) && Number(n) > 0) {
        items.push({ type, number: String(Number(n)), sku: r[cSku], description: (r[cDesc] || '').replace(/\s+/g, ' ').trim(), group });
      }
    }
  }
  return items;
}

// Words in a message that point to an equipment type (the earliest one in the message wins).
const TYPE_WORDS = [
  ['color', /(ממנן|ממנני|מינון|דוזר|דוזינג|dosing|movacolor|sysmetric)/i],
  ['heater', /(מחמם|בקר טמפ|בקר טמפרטורה|TCU|ווסת|חימום תבנית|regloplas|wensui)/i],
  ['dryer', /(ייבשן|יבשן|מייבש|ייבוש|תנור|dryer|moretto|matsui)/i],
  ['chiller', /(צ'ילר|צ׳ילר|צילר|chiller)/i],
  ['robot', /(רובוט|גריפר|תפסנית|ואקום|וקום|רנר|ראנר|ספרו|runner|sprue|מפיל|נופל|לא שולף|לא מוציא|harmo|wemo|viper|yushin|sepro|wittmann)/i],
];

/**
 * Which equipment is the message about?
 * Returns { type, number } – number may be '' when only the type is known.
 * `machine` is the machine label the classifier already found ("מכונה 339").
 */
export function detectEquipment(text, machine = '') {
  const machineNo = machine.match(/\d+/)?.[0] || '';
  // The equipment is usually named first ("תנור 705 לא מחמם"): take the earliest type word.
  const hits = TYPE_WORDS.map(([type, re]) => [type, text.match(re)]).filter(([, m]) => m).sort((a, b) => a[1].index - b[1].index);
  for (const [type, m] of hits.slice(0, 1)) {
    if (type === 'robot') return { type, number: machineNo }; // the robot has its machine's number
    // A number right after the word: "תנור 705", "ממנן צבע מס' 21", "מחמם תבנית #107"
    const after = text.slice(m.index + m[0].length);
    const num = after.match(/^[^\d\n]{0,14}?(?<!מכונה\s?|מכונה)(\d{1,3})(?!\d)/);
    const bridge = num ? after.slice(0, num.index + num[0].length - num[1].length) : '';
    if (num && !/מכונ/.test(bridge)) return { type, number: String(Number(num[1])) };
    return { type, number: '' };
  }
  if (machineNo) return { type: 'injection', number: machineNo };
  return { type: '', number: '' };
}

export function equipmentLabel(t) {
  if (!t?.eq_type) return t?.machine || '';
  return `${TYPES[t.eq_type] || t.eq_type}${t.eq_number ? ` ${t.eq_number}` : ''}`;
}
