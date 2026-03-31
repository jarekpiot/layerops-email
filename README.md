# layerops-email

**Kestrel** — LayerOps AI Email Assistant

A Cloudflare Email Worker that:

1. Receives inbound emails via Cloudflare Email Routing
2. Forwards them to Gmail for record-keeping
3. Sends an AI-powered auto-reply via the Resend API

## Setup

### Secrets (Cloudflare Dashboard → Worker → Settings → Variables and Secrets)

- `RESEND_API_KEY` — Resend API key with "Sending access" for layerops.tech

### Environment Variables (wrangler.toml)

- `FROM_EMAIL` — Sender address for replies (kestrel@layerops.tech)
- `FROM_NAME` — Display name for replies
- `FORWARD_TO` — Gmail address for forwarding

## Development

```bash
npm install
npm run dev
```

## Deployment

```bash
npm run deploy
```

Or push to the connected GitHub repo for automatic deployment.
