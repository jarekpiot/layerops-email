/**
 * LayerOps Email Worker — Kestrel AI Email Assistant
 *
 * Receives inbound emails via Cloudflare Email Routing,
 * forwards them to Gmail for record-keeping, and sends
 * an AI-powered reply using Claude + Resend.
 *
 * Secrets (set via Cloudflare dashboard or wrangler secret put):
 *   RESEND_API_KEY    — Resend "Sending access" key for layerops.tech
 *   ANTHROPIC_API_KEY — Claude API key for AI replies
 *
 * Environment variables (set in wrangler.toml [vars]):
 *   FROM_EMAIL  — sender address for replies (kestrel@layerops.tech)
 *   FROM_NAME   — display name ("Kestrel - LayerOps AI")
 *   FORWARD_TO  — email address to forward inbound mail to
 */

// ── System prompt — same knowledge as the website chatbot ────────────────

const SYSTEM_PROMPT = `You are Kestrel, the AI email assistant for LayerOps — an Australian AI implementation consultancy based in Canberra, founded by Jarek Piotrowski.

You are replying to an email that was sent to LayerOps. Write a helpful, warm reply.

LayerOps Services:
- AI Landing Pages & Funnels (from $1,500): Custom websites and landing pages built fast using AI.
- Automation Builds (from $2,000): Map manual workflows and automate them — onboarding, invoicing, lead follow-up, reporting.
- AI Content Systems (from $2,000/month): AI-powered content pipeline — blog posts, social media, newsletters. Client reviews and approves.
- Kestrel AI Employee (pilot programs available): 24/7 AI assistant that reads emails, tracks deadlines, writes reports, sends alerts.
- SEO Quick Fix (from $299): Automated audit + same-day fixes for Google rankings.
- AI Chatbot for Businesses: Custom AI chatbot + landing page deployed on your subdomain. Handles customer questions 24/7.

About Jarek:
- 20+ years enterprise IT infrastructure experience
- VMware Certified Expert
- Based in Canberra, serves all of Australia
- Contact: jarek@layerops.tech / 0404 003 240
- Free 15-minute consultation: https://cal.com/jarek-piotrowski-jay-j5oa4i/15min

Your personality:
- Warm, approachable, Australian — like emailing a helpful local
- Concise — keep replies short and to the point (under 150 words unless the question needs more)
- Not salesy — helpful and honest
- If someone asks about something you can't answer specifically, say Jarek will follow up personally
- Never make up pricing, timelines, or capabilities
- Always sign off as "Kestrel, LayerOps AI Assistant" and include Jarek's contact details

Rules:
- If the email is a general enquiry, answer what you can and suggest booking a free 15-min chat
- If someone asks for a quote, give rough starting prices from the list above and say Jarek will provide an exact quote
- If someone is unhappy or has a complaint, be empathetic and say Jarek will personally follow up
- If the email is spam or automated, don't reply (this is handled before you see it)
- Always mention that Jarek has been CC'd and will follow up personally if needed
- Write in plain text email format — no HTML, no markdown. Just natural email writing.`;

// ── Claude API call ──────────────────────────────────────────────────────

async function generateReply(apiKey, senderName, senderEmail, subject, body) {
  const userMessage = `Reply to this email.

From: ${senderName || 'Unknown'} <${senderEmail}>
Subject: ${subject || '(no subject)'}

${body || '(empty email)'}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Claude API error (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// ── Resend helper ────────────────────────────────────────────────────────

async function sendViaResend(apiKey, { from, fromName, to, subject, text, replyTo, cc }) {
  const body = {
    from: fromName ? `${fromName} <${from}>` : from,
    to: Array.isArray(to) ? to : [to],
    subject,
    text,
    ...(replyTo && { reply_to: replyTo }),
    ...(cc && { cc: Array.isArray(cc) ? cc : [cc] }),
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Parse raw email ──────────────────────────────────────────────────────

async function streamToText(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

function extractBody(raw) {
  const parts = raw.split(/\r?\n\r?\n/);
  if (parts.length < 2) return raw;
  const body = parts.slice(1).join('\n\n');
  return body
    .replace(/--[a-zA-Z0-9_-]+--?/g, '')
    .replace(/Content-Type:.*\r?\n/gi, '')
    .replace(/Content-Transfer-Encoding:.*\r?\n/gi, '')
    .trim()
    .slice(0, 3000);
}

function extractHeader(raw, headerName) {
  const regex = new RegExp(`^${headerName}:\\s*(.+)$`, 'mi');
  const match = raw.match(regex);
  return match ? match[1].trim() : null;
}

// ── Sender filtering ─────────────────────────────────────────────────────

function shouldSkipReply(from) {
  const lower = from.toLowerCase();
  const skipPatterns = [
    'noreply', 'no-reply', 'mailer-daemon', 'postmaster',
    'bounce', 'unsubscribe', 'notification', 'alert@',
    'layerops.tech', // don't reply to ourselves
  ];
  return skipPatterns.some((p) => lower.includes(p));
}

// ── Main export ──────────────────────────────────────────────────────────

export default {
  // HTTP handler (health check)
  async fetch(request, env) {
    return new Response(
      JSON.stringify({
        service: 'layerops-email',
        status: 'running',
        description: 'Kestrel — LayerOps AI Email Assistant',
        capabilities: ['email-forwarding', 'ai-auto-reply'],
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  },

  // Email handler — triggered by Cloudflare Email Routing
  async email(message, env, ctx) {
    const from = message.from;
    const to = message.to;

    console.log(`📧 Incoming email from ${from} to ${to}`);

    // 1. Forward the original email to Gmail
    try {
      await message.forward(env.FORWARD_TO);
      console.log(`✅ Forwarded to ${env.FORWARD_TO}`);
    } catch (err) {
      console.error(`❌ Forward failed: ${err.message}`);
    }

    // 2. Skip auto-reply for automated senders
    if (shouldSkipReply(from)) {
      console.log('⏭️  Skipping auto-reply (automated sender)');
      return;
    }

    // 3. Read the raw email
    let raw, senderName, subject, body;
    try {
      raw = await streamToText(message.raw);
      senderName = extractHeader(raw, 'From')?.replace(/<.*>/, '').trim() || null;
      subject = extractHeader(raw, 'Subject') || '(no subject)';
      body = extractBody(raw);
    } catch (err) {
      console.error(`❌ Failed to parse email: ${err.message}`);
      return;
    }

    // 4. Generate AI reply with Claude
    let replyText;
    try {
      if (env.ANTHROPIC_API_KEY) {
        replyText = await generateReply(
          env.ANTHROPIC_API_KEY,
          senderName,
          from,
          subject,
          body
        );
        console.log('✅ AI reply generated');
      } else {
        // Fallback if no API key — basic auto-reply
        const name = senderName || 'there';
        replyText = `Hi ${name},\n\nThanks for getting in touch! I've received your message and forwarded it to Jarek. He'll get back to you shortly.\n\nIn the meantime, feel free to check out what we do at https://layerops.tech\n\nBest regards,\nKestrel\nLayerOps AI Assistant\n\nJarek Piotrowski\njarek@layerops.tech | 0404 003 240`;
        console.log('⚠️ No ANTHROPIC_API_KEY — using fallback reply');
      }
    } catch (err) {
      console.error(`❌ AI reply generation failed: ${err.message}`);
      // Fall back to basic reply
      const name = senderName || 'there';
      replyText = `Hi ${name},\n\nThanks for getting in touch! I've received your message and forwarded it to Jarek. He'll get back to you shortly.\n\nBest regards,\nKestrel\nLayerOps AI Assistant\n\nJarek Piotrowski\njarek@layerops.tech | 0404 003 240`;
    }

    // 5. Send reply via Resend
    try {
      const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
      const result = await sendViaResend(env.RESEND_API_KEY, {
        from: env.FROM_EMAIL,
        fromName: env.FROM_NAME,
        to: from,
        cc: 'jarek@layerops.tech',
        subject: replySubject,
        text: replyText,
        replyTo: 'jarek@layerops.tech',
      });

      console.log(`✅ Reply sent via Resend: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`❌ Reply send failed: ${err.message}`);
    }
  },
};
