/**
 * LayerOps Email Worker — Kestrel AI Email Assistant
 *
 * Receives inbound emails via Cloudflare Email Routing,
 * forwards them to Gmail for record-keeping, and sends
 * an AI-powered auto-reply using the Resend API.
 *
 * Secrets (set via Cloudflare dashboard):
 *   RESEND_API_KEY — Resend "Sending access" key for layerops.tech
 *
 * Environment variables (set in wrangler.toml [vars]):
 *   FROM_EMAIL  — sender address for replies (kestrel@layerops.tech)
 *   FROM_NAME   — display name ("Kestrel - LayerOps AI")
 *   FORWARD_TO  — Gmail address to forward inbound mail to
 */

import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

// ── Resend helper ─────────────────────────────────────────────────────────
async function sendViaResend(apiKey, { from, fromName, to, subject, html, text, replyTo }) {
  const body = {
    from: fromName ? `${fromName} <${from}>` : from,
    to: Array.isArray(to) ? to : [to],
    subject,
    ...(html && { html }),
    ...(text && { text }),
    ...(replyTo && { reply_to: replyTo }),
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Parse a raw email stream into text ─────────────────────────────────
async function streamToText(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

// ── Extract plain-text body from raw email ─────────────────────────────
function extractBody(raw) {
  // Try to grab the plain text part
  const parts = raw.split(/\r?\n\r?\n/);
  if (parts.length < 2) return raw;
  // Everything after the first blank line is body
  const body = parts.slice(1).join("\n\n");
  // Strip common MIME boundaries (simple heuristic)
  return body
    .replace(/--[a-zA-Z0-9_-]+--?/g, "")
    .replace(/Content-Type:.*\r?\n/gi, "")
    .replace(/Content-Transfer-Encoding:.*\r?\n/gi, "")
    .trim()
    .slice(0, 2000); // cap length for safety
}

// ── Extract a header value from raw email ──────────────────────────────
function extractHeader(raw, headerName) {
  const regex = new RegExp(`^${headerName}:\\s*(.+)$`, "mi");
  const match = raw.match(regex);
  return match ? match[1].trim() : null;
}

// ── Build the auto-reply ─────────────────────────────────────────────
function buildAutoReply(senderName) {
  const name = senderName || "there";
  return {
    subject: "Thanks for reaching out — LayerOps",
    text: `Hi ${name},\n\nThanks for getting in touch! This is Kestrel, the AI assistant for LayerOps.\n\nI've received your message and forwarded it to Jarek. He'll get back to you shortly.\n\nIn the meantime, feel free to check out what we do at https://layerops.tech\n\nBest regards,\nKestrel\nLayerOps AI Assistant`,
    html: `<p>Hi ${name},</p>\n<p>Thanks for getting in touch! This is <strong>Kestrel</strong>, the AI assistant for LayerOps.</p>\n<p>I've received your message and forwarded it to Jarek. He'll get back to you shortly.</p>\n<p>In the meantime, feel free to check out what we do at <a href="https://layerops.tech">layerops.tech</a></p>\n<p>Best regards,<br/>\n<strong>Kestrel</strong><br/>\n<em>LayerOps AI Assistant</em></p>`,
  };
}

// ── Main export ──────────────────────────────────────────────────────
export default {
  // HTTP handler (health check / info endpoint)
  async fetch(request, env) {
    return new Response(
      JSON.stringify({
        service: "layerops-email",
        status: "running",
        description: "Kestrel — LayerOps AI Email Assistant",
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  },

  // Email handler — triggered by Cloudflare Email Routing
  async email(message, env, ctx) {
    const from = message.from;
    const to = message.to;

    console.log(`📧 Incoming email from ${from} to ${to}`);

    try {
      // 1. Forward the original email to Gmail for record-keeping
      await message.forward(env.FORWARD_TO);
      console.log(`✅ Forwarded to ${env.FORWARD_TO}`);
    } catch (err) {
      console.error(`❌ Forward failed: ${err.message}`);
    }

    try {
      // 2. Read the raw email to extract sender info
      const raw = await streamToText(message.raw);
      const senderName =
        extractHeader(raw, "From")?.replace(/<.*>/, "").trim() || null;

      // 3. Don't reply to noreply / mailer-daemon / automated senders
      const lowerFrom = from.toLowerCase();
      if (
        lowerFrom.includes("noreply") ||
        lowerFrom.includes("no-reply") ||
        lowerFrom.includes("mailer-daemon") ||
        lowerFrom.includes("postmaster") ||
        lowerFrom.endsWith("layerops.tech") // don't reply to ourselves
      ) {
        console.log("⏭️  Skipping auto-reply (automated sender)");
        return;
      }

      // 4. Send auto-reply via Resend
      const reply = buildAutoReply(senderName);
      const result = await sendViaResend(env.RESEND_API_KEY, {
        from: env.FROM_EMAIL,
        fromName: env.FROM_NAME,
        to: from,
        subject: reply.subject,
        html: reply.html,
        text: reply.text,
        replyTo: "jarek@layerops.tech",
      });

      console.log(`✅ Auto-reply sent via Resend: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`❌ Auto-reply failed: ${err.message}`);
    }
  },
};
