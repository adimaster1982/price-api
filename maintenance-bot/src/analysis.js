// Maintenance KPIs per machine, fault category and handler.
//   MTTR = average time from report to close, over tickets closed (hours).
//   Downtime = time each ticket in the period was open (open tickets count until now).
//   MTBF = (period length − downtime) / number of failures, per machine.
//          Assumes the machine was meant to run the whole period (24/7); no production calendar.
import { CATEGORY_LABEL } from './categories.js';
import { TYPES as EQ_TYPES, equipmentLabel } from './equipment.js';

const H = 3_600_000;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function handlerOf(t) {
  return t.assignee || t.closed_by || '';
}

// Hours covered by the tickets' open intervals, counting overlapping time once.
export function unionHours(list, nowMs) {
  const iv = list
    .map((t) => [Date.parse(t.created_at), t.closed_at ? Date.parse(t.closed_at) : nowMs])
    .sort((a, b) => a[0] - b[0]);
  let total = 0, start = null, end = null;
  for (const [a, b] of iv) {
    if (start === null || a > end) {
      if (start !== null) total += end - start;
      start = a; end = b;
    } else end = Math.max(end, b);
  }
  if (start !== null) total += end - start;
  return total / H;
}

function summarize(list, nowMs) {
  const repairs = list.filter((t) => t.closed_at).map((t) => (Date.parse(t.closed_at) - Date.parse(t.created_at)) / H);
  const downtime = list.reduce((s, t) => s + ((t.closed_at ? Date.parse(t.closed_at) : nowMs) - Date.parse(t.created_at)) / H, 0);
  return {
    failures: list.length,
    open: list.filter((t) => !t.closed_at).length,
    closed: repairs.length,
    mttrHours: avg(repairs),
    downtimeHours: downtime,
  };
}

export function analyze(tickets, { days = 30, now = Date.now(), category = '', eqType = '' } = {}) {
  const periodHours = days * 24;
  const since = now - days * 24 * H;
  const rows = tickets.filter(
    (t) => Date.parse(t.created_at) >= since && (!category || t.category === category) && (!eqType || (t.eq_type || '') === eqType)
  );

  const group = (keyFn) => {
    const m = new Map();
    for (const t of rows) {
      const k = keyFn(t);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    }
    return m;
  };

  // One row per piece of equipment ("מכונת הזרקה 339", "רובוט 339", "מייבש 705").
  const machines = [...group((t) => equipmentLabel(t) || 'ללא ציוד')].map(([machine, list]) => {
    const s = summarize(list, now);
    s.downtimeHours = unionHours(list, now); // a machine is down once, even with two open tickets
    const cats = {};
    for (const t of list) cats[t.category || 'other'] = (cats[t.category || 'other'] || 0) + 1;
    const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other';
    return {
      machine,
      ...s,
      mtbfHours: s.failures ? Math.max(0, periodHours - s.downtimeHours) / s.failures : null,
      topCategory: CATEGORY_LABEL[topCat] || 'אחר',
      eqType: list[0].eq_type || '',
      sku: list.find((t) => t.eq_sku)?.eq_sku || '',
      description: list.find((t) => t.eq_desc)?.eq_desc || '',
      lastFailure: list.reduce((a, t) => (t.created_at > a ? t.created_at : a), ''),
    };
  });
  machines.sort((a, b) => b.failures - a.failures || b.downtimeHours - a.downtimeHours);

  const categories = [...group((t) => t.category || 'other')]
    .map(([key, list]) => ({ key, label: CATEGORY_LABEL[key] || 'אחר', ...summarize(list, now) }))
    .sort((a, b) => b.failures - a.failures);

  const eqTypes = [...group((t) => t.eq_type || '')]
    .map(([key, list]) => ({ key, label: EQ_TYPES[key] || 'לא זוהה ציוד', ...summarize(list, now) }))
    .sort((a, b) => b.failures - a.failures);

  const handlers = [...group((t) => handlerOf(t) || 'לא ידוע')]
    .map(([name, list]) => ({ name, ...summarize(list.filter((t) => t.closed_at), now) }))
    .filter((h) => h.closed > 0)
    .sort((a, b) => b.closed - a.closed);

  const total = summarize(rows, now);
  total.downtimeHours = machines.reduce((a, m) => a + m.downtimeHours, 0);
  const mtbfs = machines.map((m) => m.mtbfHours).filter((x) => x != null);
  return {
    days,
    category,
    eqType,
    total: { ...total, machines: machines.length, mtbfHours: avg(mtbfs) },
    machines,
    categories,
    eqTypes,
    handlers,
  };
}
