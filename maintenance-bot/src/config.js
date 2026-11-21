import path from 'node:path';

const env = process.env;

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  dataDir: path.resolve(env.DATA_DIR || './data'),
  port: num(env.PORT, 3000),
  timezone: env.TZ || 'Asia/Jerusalem',

  // WhatsApp
  groupId: env.GROUP_ID || '', // optional; can also be picked in the dashboard
  managerPhones: (env.MANAGER_PHONES || '')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean),

  // Claude
  model: env.CLAUDE_MODEL || 'claude-opus-5-5',

  // Dashboard
  dashboardUser: env.DASHBOARD_USER || 'admin',
  dashboardPass: env.DASHBOARD_PASS || '',
  publicUrl: env.PUBLIC_URL || '',

  // Escalation (hours)
  urgentEscalateHours: num(env.URGENT_ESCALATE_HOURS, 2),
  normalEscalateHours: num(env.NORMAL_ESCALATE_HOURS, 48),

  // Schedules (cron, in config.timezone)
  dailySummaryCron: env.DAILY_SUMMARY_CRON || '40 6 * * 0-5',
  escalationCron: env.ESCALATION_CRON || '*/30 * * * *',
};
