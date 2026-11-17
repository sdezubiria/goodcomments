// Turns whatever a webhook sends (email services, Slack slash commands, Apple
// Shortcuts, plain text) into a comment. Used by POST /api/inbox.

/** Pull a project tag out of text: "#pabellon …" or "[Pabellón] …". */
export function splitProjectTag(text) {
  const m = text.match(/^\s*(?:#([\p{L}\p{N}_-]+)|\[([^\]]+)\])\s*[:\-–]?\s*/u);
  return m ? { tag: m[1] || m[2], rest: text.slice(m[0].length) } : { tag: null, rest: text };
}

/** Drop quoted history and signatures from an email reply. */
export function stripEmail(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^(On .+ wrote:|El .+ escribió:|-----Original Message-----|________________)/i.test(line.trim())) break;
    if (/^--\s*$/.test(line)) break;
    if (line.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @param {object} f   fields from JSON, form or text body
 * @param {URLSearchParams} q  query string (project, source, location defaults)
 * @returns {{ comment, attachments, reply }}  reply is 'slack' when Slack wants a message back
 */
export function normalize(f, q) {
  let source = q.get('source');
  let author = f.from || f.From || f.sender || f.user_name || f.author || null;
  let body;
  let reply = null;

  if (f.command && f.user_name !== undefined) {          // Slack slash command: /gc #project text
    body = f.text || '';
    source ||= 'Slack';
    reply = 'slack';
    if (f.channel_name) author = `${f.user_name} in #${f.channel_name}`;
  } else if (f.Subject !== undefined || f.subject !== undefined || f.TextBody || f['body-plain']) { // email
    const subject = (f.Subject ?? f.subject ?? '').replace(/^(re|fw|fwd|rv)\s*:\s*/gi, '').trim();
    const text = stripEmail(f.StrippedTextReply || f['stripped-text'] || f.TextBody || f['body-plain'] || f.text || f.body || '');
    body = [subject, text].filter(Boolean).join('\n\n');
    source ||= 'Email';
  } else {
    body = f.text ?? f.body ?? f.message ?? f.comment ?? '';
    source ||= f.source || 'Inbox';
  }

  body = String(body).slice(0, 8000);
  const original = body;
  const { tag, rest } = splitProjectTag(body);
  const project = f.project || q.get('project') || tag || null;
  if (tag && !f.project && !q.get('project')) body = rest;

  const attachments = [];
  for (const a of [...(f.attachments || []), ...(f.Attachments || [])]) {
    const data = a.base64 || a.Content || a.content;
    if (data) attachments.push({ name: a.name || a.Name, type: a.type || a.ContentType, data: Buffer.from(data, 'base64') });
  }

  return {
    original, // full text, used if the tagged project doesn't exist
    comment: { body, project, source, author: author && String(author).slice(0, 200), location: f.location || f.url || q.get('location') || null },
    attachments,
    reply,
  };
}
