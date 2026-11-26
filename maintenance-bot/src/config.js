import path from 'node:path';

const env = process.env;

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  dataDir: path.resolve(env.DATA_DIR || './data'),
  port: num(env.PORT, 3000),
  timezone: env.TZ || 'Asia/Jerusalem',

  // WhatsApp
  groupId: env.GROUP_ID || '', // optional; can also be picked in the dashboard
  // Link with an 8-digit pairing code instead of a QR (needed when the bot runs on the same phone)
  pairingPhone: (env.PAIRING_PHONE || '').replace(/\D/g, ''),
  managerPhones: (env.MANAGER_PHONES || '')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean),

  // Classifier: 'rules' = offline keyword rules (no cloud), 'claude' = Claude API
  classifier: (env.CLASSIFIER || 'rules').toLowerCase(),
  model: env.CLAUDE_MODEL || 'claude-opus-5-5',

  // Group feedback: 'react' = emoji on the message only (default), 'messages' = text reply per open/close
  groupFeedback: env.GROUP_FEEDBACK === 'messages' ? 'messages' : 'react',

  // Dashboard
  dashboardUser: env.DASHBOARD_USER || 'admin',
  dashboardPass: env.DASHBOARD_PASS || '',
  // Extra dashboard users: "manager:1234,yossi:5678" (name:password, comma separated)
  dashboardUsers: (env.DASHBOARD_USERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes(':'))
    .map((s) => [s.slice(0, s.indexOf(':')).trim(), s.slice(s.indexOf(':') + 1).trim()])
    .filter(([u, p]) => u && p),
  publicUrl: env.PUBLIC_URL || '',

  // Escalation (hours)
  urgentEscalateHours: num(env.URGENT_ESCALATE_HOURS, 2),
  normalEscalateHours: num(env.NORMAL_ESCALATE_HOURS, 48),

  // Schedules (cron, in config.timezone)
  // Daily summary to the group: off by default (pilot). Set a cron, e.g. '40 6 * * 0-5', to enable.
  dailySummaryCron: env.DAILY_SUMMARY_CRON || 'off',
  escalationCron: env.ESCALATION_CRON || '*/30 * * * *',
};
