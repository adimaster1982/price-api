// Fault categories for management reports. Matched in order: the first category
// whose keywords appear in the ticket text wins. Edit the keyword lists to tune.
export const CATEGORIES = [
  { key: 'pneumatic', label: 'אוויר ופנאומטיקה', re: /(שעון אוויר|לחץ אוויר|אוויר|פנאומט|מדחס|קומפרסור|ונטיל)/i },
  { key: 'hydraulic', label: 'הידראוליקה', re: /(הידראול|שמן|שסתום|ולבו|צילינדר|לחץ נמוך|לחץ גבוה|צנרת|זרנוק|אטם)/i },
  { key: 'electrical', label: 'חשמל', re: /(חשמל|קצר|פאזה|נתיך|פיוז|מפסק|ממסר|מגען|כבל|חיווט|מנוע|סנסור|חיישן|ספק כוח|נשרף|קפץ|נורה|תאורה|לא נדלק)/i },
  { key: 'peripheral', label: 'ציוד היקפי', re: /(תנור|מחמם|ממנן|מינון|דוזר|בקר טמפ|TCU|יבשן|יבשנים|מייבש|מזין|מערבל|מטען|לואדר|loader|מגרסה|טוחנת)/i },
  { key: 'robot', label: 'רובוט', re: /(רובוט|גריפר|תפסנית|ואקום|וקום|\bVG\b|רנר|ראנר|ספרו|sprue|runner|מפיל|נופל|לא שולף|לא מוציא|זרוע|Yushin|Sepro|Wittmann)/i },
  { key: 'mold', label: 'תבנית', re: /(תבנית|פלאש|flash|שורט|short|חסר מילוי|בועות|שקיעות|עיוות|פינים|פין |הוט ראנר|hot runner|חוטים|נקודות שחורות)/i },
  { key: 'cooling', label: 'קירור ומים', re: /(צ'ילר|צ׳ילר|צילר|chiller|מגדל קירור|קירור|מים|לא מקרר)/i },
  { key: 'mechanical', label: 'מכונה – מכני', re: /(בורג|פיה|נוזל|דוחף|מפלט|נעילה|ברכיים|טוגל|מצמד|שבור|נשבר|סדוק|רעש)/i },
];

export const OTHER = { key: 'other', label: 'אחר' };
export const CATEGORY_LABEL = Object.fromEntries([...CATEGORIES, OTHER].map((c) => [c.key, c.label]));

export function categorize(text = '') {
  for (const c of CATEGORIES) if (c.re.test(text)) return c.key;
  return OTHER.key;
}
