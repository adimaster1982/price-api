// Classifies one WhatsApp group message into a ticket action using Claude.
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT = `You are the maintenance-ticket assistant of a plastic injection-molding factory.
You read every message posted in the factory's WhatsApp maintenance group (written in Hebrew, sometimes with
slang, typos, English machine terms or numbers) and decide what it means for the ticket system.

Actions:
- new_ticket: someone reports a NEW fault, breakdown or maintenance need (machine, mold, chiller, robot,
  compressor, dryer, conveyor, electricity, building, etc.) that is not already an open ticket.
- update: progress/information about an EXISTING open ticket (diagnosis, part ordered, "working on it",
  photo of the problem, a question about it) without finishing it.
- close: the work on an existing ticket is done ("תוקן", "עובד", "סגור", "הוחלף והמכונה חזרה לעבוד").
- status_change: an existing ticket moves to in_progress (someone takes it / starts working) or
  waiting_parts (waiting for a part/supplier/technician), or someone is assigned to it.
- query: a question to the bot or about the ticket list ("מה פתוח?", "מה המצב במכונה 7?", "מי מטפל ב-#12?").
- ignore: greetings, thanks, chit-chat, scheduling unrelated to faults, emoji-only messages.

Rules:
- If the message is a reply to a ticket (given as "reply_to_ticket"), assume it concerns that ticket
  unless it clearly reports a different, new fault.
- If the message mentions "#<number>", it refers to that ticket.
- Otherwise match to an open ticket only when the machine and problem clearly match; if unsure whether a
  report is new or a duplicate of an open ticket on the same machine, prefer update on that ticket.
- ticket_id: the existing ticket's number for update/close/status_change, else 0.
- title: for new_ticket, a short Hebrew description of the fault (max ~8 words), else "".
- machine: machine/equipment identifier as written by the factory (e.g. "מכונה 7", "Engel 3", "צ'ילר"), or "".
- priority: urgent when production is stopped, safety risk, leak/fire/electric hazard or explicit
  urgency; low for cosmetic/non-production items; otherwise normal.
- new_status: for status_change only - in_progress or waiting_parts; else "".
- assignee: the person who takes/is assigned the job, if stated or if the sender says he is on it; else "".
- note: one short Hebrew line summarising what this message adds (for the ticket history); "" for ignore.
- reply: only for query - a concise Hebrew answer based ONLY on the open-ticket list provided; else "".
Never invent tickets, numbers or facts that are not in the input.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['new_ticket', 'update', 'close', 'status_change', 'query', 'ignore'] },
    ticket_id: { type: 'integer' },
    title: { type: 'string' },
    machine: { type: 'string' },
    priority: { type: 'string', enum: ['low', 'normal', 'urgent'] },
    new_status: { type: 'string', enum: ['', 'in_progress', 'waiting_parts'] },
    assignee: { type: 'string' },
    note: { type: 'string' },
    reply: { type: 'string' },
  },
  required: ['action', 'ticket_id', 'title', 'machine', 'priority', 'new_status', 'assignee', 'note', 'reply'],
};

export const IGNORE = Object.freeze({
  action: 'ignore', ticket_id: 0, title: '', machine: '', priority: 'normal',
  new_status: '', assignee: '', note: '', reply: '',
});

function ticketLine(t) {
  return `#${t.id} | ${t.machine || '-'} | ${t.title} | status=${t.status} | priority=${t.priority} | assignee=${t.assignee || '-'} | opened=${t.created_at.slice(0, 16)}`;
}

export function buildUserContent({ text, sender, replyToTicket, openTickets, recent }) {
  const lines = [];
  lines.push('<open_tickets>');
  lines.push(openTickets.length ? openTickets.map(ticketLine).join('\n') : '(none)');
  lines.push('</open_tickets>');
  if (recent?.length) {
    lines.push('<recent_group_messages oldest_first>');
    lines.push(recent.map((m) => `${m.sender}: ${m.text}`).join('\n'));
    lines.push('</recent_group_messages>');
  }
  lines.push('<message>');
  lines.push(`sender: ${sender}`);
  if (replyToTicket) lines.push(`reply_to_ticket: #${replyToTicket}`);
  lines.push(`text: ${text}`);
  lines.push('</message>');
  return lines.join('\n');
}

export function createClassifier({ model, client = new Anthropic(), logger = console }) {
  // Haiku has no server-side fallback; the other current models do.
  const useFallbacks = !model.startsWith('claude-haiku');

  return async function classify(input) {
    const request = {
      model,
      max_tokens: 2000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: buildUserContent(input) }],
    };
    if (useFallbacks) {
      request.betas = ['server-side-fallback-2026-07-01'];
      request.fallbacks = 'default';
    }

    let response;
    try {
      response = await client.beta.messages.create(request);
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) logger.error('Claude rate limited');
      else if (err instanceof Anthropic.AuthenticationError) logger.error('Claude auth failed - check ANTHROPIC_API_KEY');
      else if (err instanceof Anthropic.APIError) logger.error(`Claude API error ${err.status}: ${err.message}`);
      else logger.error('Claude request failed', err);
      return { ...IGNORE, error: true };
    }

    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      logger.warn(`Claude stop_reason=${response.stop_reason}`);
      return { ...IGNORE, error: true };
    }
    const textBlock = response.content.find((b) => b.type === 'text');
    try {
      return { ...IGNORE, ...JSON.parse(textBlock?.text ?? '') };
    } catch {
      logger.warn('Could not parse Claude output');
      return { ...IGNORE, error: true };
    }
  };
}
