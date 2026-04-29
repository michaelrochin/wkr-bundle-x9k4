# StokeReel

Capture your most stoked customers on video.

A self-hosted video testimonial collector. Embeds on any page or runs as a hosted URL. Records video in the browser, uploads to Cloudflare R2, never charges a SaaS bill.

**Cost:** free for ~10GB of testimonials (Cloudflare R2 free tier + Workers free tier). About $1.50/month at 100GB. Bandwidth is unmetered.

**Site:** [stokereel.com](https://stokereel.com)

---

## What you need before starting

- A Cloudflare account (free): https://dash.cloudflare.com/sign-up
- Node.js installed on your computer (for `wrangler`, the deploy tool)

---

## Step 1 — Set up Cloudflare R2 (the video storage)

1. Log into Cloudflare. In the left sidebar click **R2 Object Storage**. Enable it (it'll ask for a payment method even on free tier — Cloudflare won't charge unless you exceed 10GB).
2. Click **Create bucket**. Name it `rotem-testimonials` (or whatever). Region: Automatic.
3. Once created, go to **Manage R2 API Tokens** (top right of the R2 page) → **Create API Token**.
   - Permission: **Object Read & Write**
   - Specify bucket: pick the one you just made
   - TTL: forever (or whatever you like)
4. Copy and save:
   - **Access Key ID**
   - **Secret Access Key**
   - **Account ID** (visible on the right side of the R2 dashboard, or the main Cloudflare dashboard)
5. Apply CORS to the bucket. In the bucket settings → **CORS Policy**, paste the contents of `cors.json` from this folder. Update the `AllowedOrigins` to include your GHL domain (e.g. `https://yourdomain.com` and the GHL funnel domain).

---

## Step 2 — Deploy the Cloudflare Worker

Open a terminal in this folder.

```bash
npm install -g wrangler
wrangler login
```

Edit `wrangler.toml` and set:
- `name` (whatever you want, e.g. `rotem-testimonials`)
- `account_id` (your Cloudflare account ID)

Set the secrets (one at a time — wrangler will prompt for the value):

```bash
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_ACCOUNT_ID
wrangler secret put R2_BUCKET_NAME
```

Deploy:

```bash
wrangler deploy
```

Wrangler will print the Worker URL. Copy it. Looks like:
`https://rotem-testimonials.michaelrochin.workers.dev`

---

## Step 3 — Embed the recorder

1. Open `recorder.html` in a text editor.
2. At the top of the `<script>` block, find `const WORKER_URL = "..."` and paste in your Worker URL from step 2.
3. (Optional) Edit the `QUESTIONS` array if you want different prompts.
4. On your page (GHL Custom Code element, or any HTML page), paste the entire contents of `recorder.html`. Save and publish.

---

## Step 4 — Test it

- Open the page on your phone
- Walk through the flow
- Confirm the video appears in the R2 bucket (Cloudflare dashboard → R2 → your bucket)

---

## Troubleshooting

- **"Permission denied" when trying to record:** the user denied camera/mic permission in their browser. Page tells them to enable it.
- **CORS error in the browser console on upload:** your R2 CORS policy doesn't include the domain you're testing from. Update `cors.json`, re-apply.
- **Video file is huge:** that's normal. Phone videos are 50–200MB per minute. R2's free tier is 10GB, so you can collect ~50–100 testimonials before paying anything (and even after that, R2 is $0.015/GB/month, so 100GB is $1.50/month).

---

## Files in this folder

| File | What it is |
|------|-----------|
| `recorder.html` | Drop into a GHL custom code element |
| `worker.js` | Cloudflare Worker source |
| `wrangler.toml` | Worker deploy config |
| `cors.json` | R2 CORS policy (paste into bucket settings) |
| `CLAUDE.md` | Notes for Claude Code if you want to ask it to modify anything |
