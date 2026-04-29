/**
 * Cloudflare Worker — Video Testimonial Backend
 *
 * Endpoints:
 *   POST /presign         -> returns a presigned PUT URL for direct browser-to-R2 upload
 *   GET  /admin           -> serves the password-protected admin viewer page
 *   POST /admin/list      -> returns all submissions with playable URLs (password-gated)
 *   GET  /config          -> serves the password-protected branding dashboard
 *   POST /config/get      -> returns config JSON for a client (password-gated)
 *   POST /config/save     -> saves config JSON to R2 (password-gated)
 *   GET  /config/public   -> public read of config for a client (called by recorder.html)
 *
 * Deploy with: wrangler deploy
 *
 * Required secrets (set with `wrangler secret put`):
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_ACCOUNT_ID
 *   R2_BUCKET_NAME
 *   ADMIN_PASSWORD
 *
 * Required binding (in wrangler.toml):
 *   BUCKET -> the R2 bucket
 */

import { AwsClient } from "aws4fetch";
import RECORDER_HTML from "./recorder.html";
import LANDING_HTML from "./landing.html";

// --------------------------------------------------------------
// Credential resolution
// First-run wizard writes credentials to R2 at _system/setup.json.
// Older installs use wrangler secrets. Read R2 first, fall back to env.
// --------------------------------------------------------------
let _setupCache = null;
let _setupCacheTime = 0;

async function getSetup(env) {
  const now = Date.now();
  if (_setupCache && (now - _setupCacheTime) < 30_000) return _setupCache;
  try {
    const r = await env.BUCKET.get("_system/setup.json");
    if (r) {
      _setupCache = JSON.parse(await r.text());
      _setupCacheTime = now;
      return _setupCache;
    }
  } catch {}
  _setupCache = null;
  return null;
}

async function getCred(env, key) {
  const setup = await getSetup(env);
  if (setup && setup[key]) return setup[key];
  return env[key];
}

async function isConfigured(env) {
  return Boolean(
    await getCred(env, "ADMIN_PASSWORD") &&
    await getCred(env, "R2_ACCESS_KEY_ID") &&
    await getCred(env, "R2_SECRET_ACCESS_KEY") &&
    await getCred(env, "R2_ACCOUNT_ID") &&
    await getCred(env, "R2_BUCKET_NAME")
  );
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    try {
      if ((url.pathname === "/" || url.pathname === "/start") && request.method === "GET") {
        return new Response(LANDING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/setup" && request.method === "GET") {
        return new Response(SETUP_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/setup/status" && request.method === "GET") {
        return withCors(new Response(JSON.stringify({ configured: await isConfigured(env) }), {
          headers: { "Content-Type": "application/json" }
        }));
      }
      if (url.pathname === "/setup/save" && request.method === "POST") {
        return withCors(await handleSetupSave(request, env));
      }

      // Gate the dashboard behind setup completion
      if ((url.pathname === "/config" || url.pathname === "/admin") && request.method === "GET") {
        if (!(await isConfigured(env))) {
          return Response.redirect(url.origin + "/setup", 302);
        }
      }

      if (url.pathname === "/presign" && request.method === "POST") {
        return withCors(await handlePresign(request, env));
      }
      if (url.pathname === "/admin" && request.method === "GET") {
        return new Response(ADMIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/admin/list" && request.method === "POST") {
        return withCors(await handleAdminList(request, env));
      }
      if (url.pathname === "/config" && request.method === "GET") {
        return new Response(CONFIG_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/config/get" && request.method === "POST") {
        return withCors(await handleConfigGet(request, env));
      }
      if (url.pathname === "/config/save" && request.method === "POST") {
        return withCors(await handleConfigSave(request, env));
      }
      if (url.pathname === "/config/delete" && request.method === "POST") {
        return withCors(await handleConfigDelete(request, env));
      }
      if (url.pathname === "/config/clients" && request.method === "POST") {
        return withCors(await handleConfigClients(request, env));
      }
      if (url.pathname === "/config/funnels" && request.method === "POST") {
        return withCors(await handleConfigFunnels(request, env));
      }
      if (url.pathname === "/config/public" && request.method === "GET") {
        return withCors(await handleConfigPublic(request, env));
      }

      if (url.pathname === "/notify" && request.method === "POST") {
        return withCors(await handleNotify(request, env));
      }
      if (url.pathname === "/admin/export" && request.method === "POST") {
        return withCors(await handleAdminExport(request, env));
      }
      if (url.pathname === "/admin/feature" && request.method === "POST") {
        return withCors(await handleAdminFeature(request, env));
      }
      if (url.pathname === "/featured" && request.method === "GET") {
        return withCors(await handleFeaturedPublic(request, env));
      }
      if (url.pathname === "/admin/upload-logo" && request.method === "POST") {
        return withCors(await handleLogoUpload(request, env));
      }
      const logoMatch = url.pathname.match(/^\/logo\/([^/]+)$/);
      if (logoMatch && request.method === "GET") {
        return await serveLogo(env, logoMatch[1]);
      }

      // Hosted recorder: /r/<client>/<funnel> serves the full recorder page,
      // ready to share as a link or embed in an iframe.
      const recorderMatch = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/?$/);
      if (recorderMatch && request.method === "GET") {
        return serveHostedRecorder(url.origin, recorderMatch[1], recorderMatch[2]);
      }

      return withCors(new Response("Not found", { status: 404 }));
    } catch (err) {
      console.error(err);
      return withCors(new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }));
    }
  }
};

// --------------------------------------------------------------
// /presign — generate a presigned PUT URL for R2 + write a metadata sidecar
// --------------------------------------------------------------
async function handlePresign(request, env) {
  const { name, email, extension = "webm", contentType = "video/webm", course = "general", client = "general" } = await request.json();

  if (!email || !name) {
    return new Response(JSON.stringify({ error: "name and email required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const datePart = new Date().toISOString().slice(0, 10);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const random = crypto.randomUUID().slice(0, 8);
  const safeExt = /^[a-z0-9]+$/i.test(extension) ? extension : "webm";
  const sanitizeFolder = (s) => (s || "general").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "general";
  const clientFolder = sanitizeFolder(client);
  const courseFolder = sanitizeFolder(course);
  const key = `testimonials/${clientFolder}/${courseFolder}/${datePart}_${slug}_${random}.${safeExt}`;

  // For video uploads, write a sidecar metadata file so the admin viewer can show
  // name + email even though the video itself is opaque. Text submissions already
  // include their own metadata in the JSON body so we skip the sidecar there.
  if (safeExt !== "json") {
    const meta = {
      name,
      email,
      client: clientFolder,
      course: courseFolder,
      submittedAt: new Date().toISOString(),
      type: "video",
      videoKey: key
    };
    await env.BUCKET.put(`${key}.meta.json`, JSON.stringify(meta, null, 2), {
      httpMetadata: { contentType: "application/json" }
    });
  }

  const r2Endpoint = `https://${await getCred(env, "R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  const objectUrl = `${r2Endpoint}/${await getCred(env, "R2_BUCKET_NAME")}/${key}`;

  const aws = new AwsClient({
    accessKeyId: await getCred(env, "R2_ACCESS_KEY_ID"),
    secretAccessKey: await getCred(env, "R2_SECRET_ACCESS_KEY"),
    service: "s3",
    region: "auto"
  });

  const signed = await aws.sign(
    new Request(objectUrl + "?X-Amz-Expires=900", {
      method: "PUT",
      headers: { "Content-Type": contentType }
    }),
    { aws: { signQuery: true } }
  );

  return new Response(JSON.stringify({
    uploadUrl: signed.url,
    videoUrl: objectUrl,
    key
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

// --------------------------------------------------------------
// /admin/list — password-gated submission listing for the admin viewer
// --------------------------------------------------------------
async function handleAdminList(request, env) {
  const { password } = await request.json().catch(() => ({}));
  const adminPw = await getCred(env, "ADMIN_PASSWORD");
  if (!adminPw || password !== adminPw) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const list = await env.BUCKET.list({ prefix: "testimonials/", limit: 1000 });

  const aws = new AwsClient({
    accessKeyId: await getCred(env, "R2_ACCESS_KEY_ID"),
    secretAccessKey: await getCred(env, "R2_SECRET_ACCESS_KEY"),
    service: "s3",
    region: "auto"
  });

  // Bucket out objects: meta files (.meta.json), text submissions (.json), videos.
  const metaByKey = new Map();
  const textKeys = [];
  const videoKeys = [];

  for (const obj of list.objects) {
    if (obj.key.endsWith(".meta.json")) {
      metaByKey.set(obj.key.replace(".meta.json", ""), obj);
    } else if (obj.key.endsWith(".json")) {
      textKeys.push(obj);
    } else {
      videoKeys.push(obj);
    }
  }

  const items = [];

  // Path layouts:
  //   New: testimonials/<client>/<course>/<file>           -> 4 parts
  //   Legacy: testimonials/<course>/<file>                 -> 3 parts (treat client as "legacy")
  function parseKey(key) {
    const parts = key.split("/");
    if (parts.length >= 4) return { client: parts[1], course: parts[2] };
    if (parts.length === 3) return { client: "legacy", course: parts[1] };
    return { client: "general", course: "general" };
  }

  // Video submissions — pair each video with its meta sidecar (when present)
  for (const obj of videoKeys) {
    const { client: clientFromKey, course } = parseKey(obj.key);
    let name = "(unknown)";
    let email = "";
    let submittedAt = null;
    let clientFromMeta = null;

    const metaObj = metaByKey.get(obj.key);
    if (metaObj) {
      const r = await env.BUCKET.get(metaObj.key);
      if (r) {
        try {
          const meta = JSON.parse(await r.text());
          name = meta.name || name;
          email = meta.email || "";
          submittedAt = meta.submittedAt || null;
          clientFromMeta = meta.client || null;
        } catch {}
      }
    }

    const r2Endpoint = `https://${await getCred(env, "R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
    const objectUrl = `${r2Endpoint}/${await getCred(env, "R2_BUCKET_NAME")}/${obj.key}`;
    const signed = await aws.sign(
      new Request(objectUrl + "?X-Amz-Expires=3600", { method: "GET" }),
      { aws: { signQuery: true } }
    );

    items.push({
      type: "video",
      key: obj.key,
      client: clientFromMeta || clientFromKey,
      course,
      name,
      email,
      submittedAt: submittedAt || obj.uploaded.toISOString(),
      sizeBytes: obj.size,
      videoUrl: signed.url
    });
  }

  // Text submissions — read JSON content inline
  for (const obj of textKeys) {
    const { client: clientFromKey, course } = parseKey(obj.key);
    const r = await env.BUCKET.get(obj.key);
    let payload = null;
    if (r) {
      try { payload = JSON.parse(await r.text()); } catch {}
    }
    items.push({
      type: "text",
      key: obj.key,
      client: payload?.client || clientFromKey,
      course,
      name: payload?.name || "(unknown)",
      email: payload?.email || "",
      submittedAt: payload?.submittedAt || obj.uploaded.toISOString(),
      responses: payload?.responses || []
    });
  }

  // Newest first
  items.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));

  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

// --------------------------------------------------------------
// /r/<client>/<funnel> — hosted recorder page
// Serve the recorder HTML from the Worker so customers can share a link
// directly or embed via iframe (instead of pasting 800 lines into GHL).
// --------------------------------------------------------------
function serveHostedRecorder(origin, client, course) {
  const safeClient = (client || "general").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60) || "general";
  const safeCourse = (course || "general").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60) || "general";
  const inject = `<script>window.VT_HOSTED=true;window.VT_WORKER_URL=${JSON.stringify(origin)};window.VT_CLIENT=${JSON.stringify(safeClient)};window.VT_COURSE=${JSON.stringify(safeCourse)};</script>`;
  // Wrap the (HTML fragment) recorder in a complete document so it can render standalone.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Share your story · StokeReel</title>
${inject}
</head>
<body style="margin:0;padding:24px 0;background:#faf7f2;">
${RECORDER_HTML}
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Allow the page (and iframes embedding it) to use camera + microphone
      "Permissions-Policy": "camera=(self), microphone=(self)",
      "Cache-Control": "public, max-age=60"
    }
  });
}

// --------------------------------------------------------------
// /config endpoints — branding dashboard for buyers
// --------------------------------------------------------------
const DEFAULT_CONFIG = {
  brandColor: "#c9a961",
  brandColorDark: "#a88840",
  buttonTextColor: "#ffffff",
  backgroundColor: "#faf7f2",
  textColor: "#1a1a1a",
  mutedTextColor: "#6b6b6b",
  borderColor: "#e5e0d6",
  errorColor: "#b84a3a",
  headingFont: 'Georgia, "Times New Roman", serif',
  headingFontGoogleUrl: "",
  headline: "Share your story",
  subheadline: 'Three quick questions in one short video. Hit record, answer them one after another, tap "Next question" as you go.',
  thankYouHeader: "Thank you.",
  thankYouBody: "That means a lot. I'll be in touch.",
  signature: "",
  supportEmail: "",
  getStartedLabel: "Get started",
  startRecordingLabel: "Start recording",
  nextQuestionLabel: "Next question →",
  doneReviewLabel: "Done — review",
  restartLabel: "Start over",
  submitLabel: "Looks good — submit",
  submitTextLabel: "Submit",
  typeInsteadLabel: "Prefer to type instead? Click here.",
  switchToVideoLabel: "Switch to video instead",
  showTypeInsteadLink: true,
  showSwitchToVideoLink: true,
  allowVideo: true,
  allowText: true,
  maxRecordingSeconds: 300,
  thankYouButtonLabel: "",
  thankYouButtonUrl: "",
  notifyWebhookUrl: "",
  logoUrl: "",
  customDomain: "",
  questions: [
    { text: "What were you struggling with before you joined?", helper: "What was actually frustrating you?" },
    { text: "What's the biggest thing that's changed for you?", helper: "Be specific — what shifted, what's different now?" },
    { text: "What would you tell someone who's on the fence?", helper: "Imagine a friend asked if they should buy. What would you say?" }
  ]
};

function sanitizeSlug(s, fallback) {
  return (s || fallback || "general").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || (fallback || "general");
}

async function readConfigKey(env, key) {
  const r = await env.BUCKET.get(key);
  if (!r) return null;
  try {
    return JSON.parse(await r.text());
  } catch {
    return null;
  }
}

// Try most-specific (course) first, fall back to client-level brand config
async function readConfig(env, client, course) {
  const c = sanitizeSlug(client);
  if (course) {
    const co = sanitizeSlug(course);
    const courseConfig = await readConfigKey(env, `config/${c}/${co}.json`);
    if (courseConfig) return { config: courseConfig, scope: "course" };
  }
  const clientConfig = await readConfigKey(env, `config/${c}.json`);
  if (clientConfig) return { config: clientConfig, scope: "client" };
  return { config: null, scope: null };
}

async function handleConfigPublic(request, env) {
  const url = new URL(request.url);
  const client = sanitizeSlug(url.searchParams.get("client"));
  const course = url.searchParams.get("course") ? sanitizeSlug(url.searchParams.get("course")) : null;
  const { config: stored } = await readConfig(env, client, course);
  const merged = { ...DEFAULT_CONFIG, ...(stored || {}) };
  return new Response(JSON.stringify(merged), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" }
  });
}

async function handleConfigGet(request, env) {
  const { password, client, course } = await request.json().catch(() => ({}));
  const adminPw = await getCred(env, "ADMIN_PASSWORD");
  if (!adminPw || password !== adminPw) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  const c = sanitizeSlug(client);
  const co = course ? sanitizeSlug(course) : null;

  // If editing a course-level config, look for it first.
  // If it doesn't exist, return the brand-wide (client) config as the starting point so the user
  // sees the inherited values when they begin customizing this funnel.
  let scope = co ? "course" : "client";
  let inherited = false;
  let stored = co ? await readConfigKey(env, `config/${c}/${co}.json`) : null;
  if (!stored) {
    if (co) inherited = true;
    stored = await readConfigKey(env, `config/${c}.json`);
  }
  return new Response(JSON.stringify({
    config: stored || DEFAULT_CONFIG,
    defaults: DEFAULT_CONFIG,
    scope,
    inherited,
    client: c,
    course: co
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function handleConfigSave(request, env) {
  const { password, client, course, config } = await request.json().catch(() => ({}));
  const adminPw = await getCred(env, "ADMIN_PASSWORD");
  if (!adminPw || password !== adminPw) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (!config || typeof config !== "object") {
    return new Response(JSON.stringify({ error: "config required" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const c = sanitizeSlug(client);
  const co = course ? sanitizeSlug(course) : null;
  // Merge config onto DEFAULT_CONFIG, but treat empty strings as "use default" so
  // accidentally-cleared fields don't overwrite meaningful defaults like "Get started".
  const merged = { ...DEFAULT_CONFIG };
  for (const k in config) {
    const v = config[k];
    if (typeof v === "string" && v === "" && typeof DEFAULT_CONFIG[k] === "string" && DEFAULT_CONFIG[k] !== "") continue;
    merged[k] = v;
  }
  const key = co ? `config/${c}/${co}.json` : `config/${c}.json`;
  await env.BUCKET.put(key, JSON.stringify(merged, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });
  return new Response(JSON.stringify({ ok: true, client: c, course: co, scope: co ? "course" : "client" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function handleConfigClients(request, env) {
  const { password } = await request.json().catch(() => ({}));
  const adminPw = await getCred(env, "ADMIN_PASSWORD");
  if (!adminPw || password !== adminPw) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  const clients = new Set();
  // Collect every prefix and object under config/ — handles brand-level + funnel-level configs
  let cursor = undefined;
  while (true) {
    const list = await env.BUCKET.list({ prefix: "config/", delimiter: "/", cursor, limit: 1000 });
    for (const obj of list.objects || []) {
      const m = obj.key.match(/^config\/([^/]+)\.json$/);
      if (m) clients.add(m[1]);
    }
    for (const prefix of list.delimitedPrefixes || []) {
      const m = prefix.match(/^config\/([^/]+)\/$/);
      if (m) clients.add(m[1]);
    }
    if (!list.truncated) break;
    cursor = list.cursor;
  }
  return new Response(JSON.stringify({ clients: [...clients].sort() }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function handleConfigFunnels(request, env) {
  const { password, client } = await request.json().catch(() => ({}));
  const adminPw = await getCred(env, "ADMIN_PASSWORD");
  if (!adminPw || password !== adminPw) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  const c = sanitizeSlug(client);
  const funnels = new Set();
  let cursor = undefined;
  while (true) {
    const list = await env.BUCKET.list({ prefix: `config/${c}/`, limit: 1000, cursor });
    for (const obj of list.objects || []) {
      const m = obj.key.match(new RegExp(`^config/${c}/([^/]+)\\.json$`));
      if (m) funnels.add(m[1]);
    }
    if (!list.truncated) break;
    cursor = list.cursor;
  }
  return new Response(JSON.stringify({ funnels: [...funnels].sort() }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function handleConfigDelete(request, env) {
  const { password, client, course } = await request.json().catch(() => ({}));
  const adminPw = await getCred(env, "ADMIN_PASSWORD");
  if (!adminPw || password !== adminPw) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (!course) {
    return new Response(JSON.stringify({ error: "course required for delete" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const c = sanitizeSlug(client);
  const co = sanitizeSlug(course);
  await env.BUCKET.delete(`config/${c}/${co}.json`);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

// --------------------------------------------------------------
// /admin/feature + /featured — featured testimonials on the intro screen
// --------------------------------------------------------------
async function readFeaturedList(env, client) {
  const c = sanitizeSlug(client);
  const r = await env.BUCKET.get(`featured/${c}.json`);
  if (!r) return [];
  try {
    const parsed = JSON.parse(await r.text());
    return Array.isArray(parsed.keys) ? parsed.keys : [];
  } catch { return []; }
}

async function writeFeaturedList(env, client, keys) {
  const c = sanitizeSlug(client);
  await env.BUCKET.put(`featured/${c}.json`, JSON.stringify({ keys: [...new Set(keys)] }, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });
}

async function handleAdminFeature(request, env) {
  const { password, client, key, featured } = await request.json().catch(() => ({}));
  const adminPw = await getCred(env, "ADMIN_PASSWORD");
  if (!adminPw || password !== adminPw) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    });
  }
  if (!client || !key) {
    return new Response(JSON.stringify({ error: "client and key required" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }
  const list = await readFeaturedList(env, client);
  const next = featured ? [...list, key] : list.filter(k => k !== key);
  await writeFeaturedList(env, client, next);
  return new Response(JSON.stringify({ ok: true, featured: featured ? true : false }), {
    status: 200, headers: { "Content-Type": "application/json" }
  });
}

async function handleFeaturedPublic(request, env) {
  const url = new URL(request.url);
  const client = sanitizeSlug(url.searchParams.get("client") || "general");
  const keys = await readFeaturedList(env, client);
  if (keys.length === 0) {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" }
    });
  }
  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3", region: "auto"
  });
  const items = [];
  for (const key of keys) {
    if (key.endsWith(".json")) continue; // skip text submissions in the carousel
    const objectUrl = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`;
    const signed = await aws.sign(
      new Request(objectUrl + "?X-Amz-Expires=3600", { method: "GET" }),
      { aws: { signQuery: true } }
    );
    items.push({ key, videoUrl: signed.url });
  }
  return new Response(JSON.stringify({ items }), {
    status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" }
  });
}

// --------------------------------------------------------------
// /admin/upload-logo + /logo/<client> — logo storage
// --------------------------------------------------------------
const ALLOWED_LOGO_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/svg+xml": "svg",
  "image/webp": "webp"
};
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2MB

async function handleLogoUpload(request, env) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return new Response(JSON.stringify({ error: "expected multipart/form-data" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }
  const password = formData.get("password");
  const client = formData.get("client");
  const file = formData.get("file");

  const adminPw = await getCred(env, "ADMIN_PASSWORD");
  if (!adminPw || password !== adminPw) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    });
  }
  if (!client || !file || typeof file === "string") {
    return new Response(JSON.stringify({ error: "client and file required" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }
  const ext = ALLOWED_LOGO_TYPES[file.type];
  if (!ext) {
    return new Response(JSON.stringify({ error: "unsupported file type. PNG, JPG, SVG, or WebP only." }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }
  const buf = await file.arrayBuffer();
  if (buf.byteLength > MAX_LOGO_BYTES) {
    return new Response(JSON.stringify({ error: "logo too large (max 2MB)" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }
  const c = sanitizeSlug(client);
  const key = `logos/${c}.${ext}`;
  await env.BUCKET.put(key, buf, { httpMetadata: { contentType: file.type } });

  // Cache-bust query param so old cached logos clear after upload
  const url = new URL(request.url);
  const logoUrl = `${url.origin}/logo/${c}?v=${Date.now()}`;
  return new Response(JSON.stringify({ ok: true, logoUrl, key }), {
    status: 200, headers: { "Content-Type": "application/json" }
  });
}

async function serveLogo(env, clientSlug) {
  const c = sanitizeSlug(clientSlug);
  const candidates = ["png", "jpg", "svg", "webp"];
  for (const ext of candidates) {
    const obj = await env.BUCKET.get(`logos/${c}.${ext}`);
    if (obj) {
      return new Response(obj.body, {
        status: 200,
        headers: {
          "Content-Type": obj.httpMetadata?.contentType || "image/png",
          "Cache-Control": "public, max-age=300"
        }
      });
    }
  }
  return new Response("logo not found", { status: 404 });
}

// --------------------------------------------------------------
// /notify — fire customer-configured webhook after a successful upload
// --------------------------------------------------------------
async function handleNotify(request, env) {
  const body = await request.json().catch(() => ({}));
  const { client, course, name, email, type, key, videoUrl } = body;
  if (!client) {
    return new Response(JSON.stringify({ ok: false, reason: "client required" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }
  const { config } = await readConfig(env, sanitizeSlug(client), course ? sanitizeSlug(course) : null);
  const merged = { ...DEFAULT_CONFIG, ...(config || {}) };
  const webhookUrl = (merged.notifyWebhookUrl || "").trim();
  if (!webhookUrl) {
    return new Response(JSON.stringify({ ok: true, skipped: "no webhook configured" }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  }
  const payload = {
    text: `New ${type === "text" ? "text" : "video"} testimonial from ${name || "(anonymous)"} ${email ? "(" + email + ")" : ""} for ${client}/${course || "general"}`,
    type: type || "video",
    client, course: course || "",
    name: name || "",
    email: email || "",
    submittedAt: new Date().toISOString(),
    key: key || "",
    videoUrl: videoUrl || ""
  };
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return new Response(JSON.stringify({ ok: res.ok, status: res.status }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  }
}

// --------------------------------------------------------------
// /admin/export — CSV download of all submissions (password-gated)
// --------------------------------------------------------------
async function handleAdminExport(request, env) {
  const { password } = await request.json().catch(() => ({}));
  const adminPw = await getCred(env, "ADMIN_PASSWORD");
  if (!adminPw || password !== adminPw) {
    return new Response("unauthorized", { status: 401 });
  }
  const list = await env.BUCKET.list({ prefix: "testimonials/", limit: 1000 });
  const csvEscape = (s) => {
    if (s == null) return "";
    const str = String(s).replace(/"/g, '""');
    return /[",\n]/.test(str) ? `"${str}"` : str;
  };
  const rows = [["type", "client", "course", "name", "email", "submitted_at", "key"]];

  for (const obj of list.objects) {
    if (obj.key.endsWith(".meta.json")) continue;
    const isText = obj.key.endsWith(".json") && !obj.key.endsWith(".meta.json");
    const parts = obj.key.split("/");
    let client = "general", course = "general";
    if (parts.length >= 4) { client = parts[1]; course = parts[2]; }
    else if (parts.length === 3) { client = "legacy"; course = parts[1]; }

    let name = "", email = "", submittedAt = obj.uploaded.toISOString(), type = "video";
    if (isText) {
      type = "text";
      const r = await env.BUCKET.get(obj.key);
      if (r) {
        try {
          const p = JSON.parse(await r.text());
          name = p.name || "";
          email = p.email || "";
          submittedAt = p.submittedAt || submittedAt;
        } catch {}
      }
    } else {
      const meta = await env.BUCKET.get(obj.key + ".meta.json");
      if (meta) {
        try {
          const m = JSON.parse(await meta.text());
          name = m.name || "";
          email = m.email || "";
          submittedAt = m.submittedAt || submittedAt;
        } catch {}
      }
    }
    rows.push([type, client, course, name, email, submittedAt, obj.key]);
  }
  const csv = rows.map(r => r.map(csvEscape).join(",")).join("\n");
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="testimonials-${new Date().toISOString().slice(0,10)}.csv"`
    }
  });
}

// --------------------------------------------------------------
// /setup/save — first-run wizard saves credentials to R2
// --------------------------------------------------------------
async function handleSetupSave(request, env) {
  const body = await request.json().catch(() => ({}));
  const required = ["adminPassword", "r2AccountId", "r2AccessKeyId", "r2SecretAccessKey", "r2BucketName"];
  for (const k of required) {
    if (!body[k] || typeof body[k] !== "string") {
      return new Response(JSON.stringify({ error: "missing " + k }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }
  }
  // If already configured, require either the existing admin password or a master env override.
  if (await isConfigured(env)) {
    const existingAdmin = await getCred(env, "ADMIN_PASSWORD");
    if (body.currentPassword !== existingAdmin) {
      return new Response(JSON.stringify({ error: "already configured — pass currentPassword to overwrite" }), {
        status: 401, headers: { "Content-Type": "application/json" }
      });
    }
  }
  const setup = {
    ADMIN_PASSWORD: body.adminPassword,
    R2_ACCOUNT_ID: body.r2AccountId,
    R2_ACCESS_KEY_ID: body.r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: body.r2SecretAccessKey,
    R2_BUCKET_NAME: body.r2BucketName
  };
  await env.BUCKET.put("_system/setup.json", JSON.stringify(setup, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });
  _setupCache = null; // bust cache
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "Content-Type": "application/json" }
  });
}

// --------------------------------------------------------------
// CORS helpers
// --------------------------------------------------------------
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function withCors(response) {
  const newHeaders = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    newHeaders.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

// --------------------------------------------------------------
// Admin viewer page (served at GET /admin)
// --------------------------------------------------------------
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StokeReel · Testimonials</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231a1a1a'/%3E%3Cpolygon points='24,16 24,48 52,32' fill='%23c9a961'/%3E%3C/svg%3E">
<style>
  :root {
    --cream: #faf7f2;
    --ink: #1a1a1a;
    --warm: #c9a961;
    --muted: #6b6b6b;
    --border: #e5e0d6;
    --error: #b84a3a;
    --card: #ffffff;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--cream);
    color: var(--ink);
    margin: 0;
    padding: 24px;
    line-height: 1.5;
  }
  h1 { font-family: Georgia, serif; font-weight: normal; margin: 0 0 24px; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
  .controls { display: flex; gap: 12px; flex-wrap: wrap; }
  .controls select, .controls input {
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 14px;
    background: white;
  }
  button {
    background: var(--warm);
    color: white;
    border: none;
    padding: 10px 18px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
  }
  button:hover { background: #a88840; }
  .gate { max-width: 320px; margin: 80px auto; text-align: center; }
  .gate input { width: 100%; padding: 12px; border: 1px solid var(--border); border-radius: 4px; font-size: 16px; margin: 16px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .card video { width: 100%; height: 240px; object-fit: cover; background: #000; display: block; }
  .card-text { padding: 20px; }
  .card-text .answer { background: var(--cream); padding: 12px; border-radius: 4px; margin: 8px 0; font-size: 14px; }
  .card-text .answer-q { font-weight: 600; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
  .card-meta { padding: 12px 16px; border-top: 1px solid var(--border); font-size: 13px; }
  .card-meta .name { font-weight: 600; }
  .card-meta .email { color: var(--muted); }
  .card-meta .date { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .badge { display: inline-block; background: var(--cream); border: 1px solid var(--border); padding: 2px 8px; border-radius: 12px; font-size: 11px; color: var(--muted); margin-left: 6px; }
  .badge.text { background: #eef4ff; border-color: #c8d8f4; color: #2a4a8a; }
  .empty { text-align: center; color: var(--muted); padding: 60px 20px; }
  .error { color: var(--error); padding: 12px; background: #fdf0ed; border-radius: 4px; }
  .count { color: var(--muted); font-size: 14px; }
  .download-link { display: inline-block; font-size: 12px; color: var(--muted); margin-top: 4px; text-decoration: underline; }
</style>
</head>
<body>

<div id="gate" class="gate" style="display:none;">
  <h1>Testimonials</h1>
  <p style="color: var(--muted);">Enter the admin password to view submissions.</p>
  <input type="password" id="pw" placeholder="Password" />
  <button onclick="login()">Sign in</button>
  <div id="gateErr" class="error" style="margin-top:12px; display:none;"></div>
</div>

<div id="app" style="display:none;">
  <div class="header">
    <h1>Testimonials <span id="count" class="count"></span></h1>
    <div class="controls">
      <select id="clientFilter">
        <option value="">All clients</option>
      </select>
      <select id="filter">
        <option value="">All courses</option>
      </select>
      <button onclick="refresh()">Refresh</button>
      <button onclick="logout()" style="background:#666;">Sign out</button>
    </div>
  </div>
  <div id="grid" class="grid"></div>
</div>

<script>
const STORAGE_KEY = "vt_admin_pw";
let allItems = [];

function showGate() {
  document.getElementById("gate").style.display = "block";
  document.getElementById("app").style.display = "none";
}
function showApp() {
  document.getElementById("gate").style.display = "none";
  document.getElementById("app").style.display = "block";
}

async function login() {
  const pw = document.getElementById("pw").value;
  if (!pw) return;
  localStorage.setItem(STORAGE_KEY, pw);
  await refresh();
}

function logout() {
  localStorage.removeItem(STORAGE_KEY);
  showGate();
}

async function refresh() {
  const pw = localStorage.getItem(STORAGE_KEY);
  if (!pw) { showGate(); return; }

  document.getElementById("gateErr").style.display = "none";
  try {
    const res = await fetch("/admin/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw })
    });
    if (res.status === 401) {
      const errEl = document.getElementById("gateErr");
      errEl.textContent = "Wrong password.";
      errEl.style.display = "block";
      localStorage.removeItem(STORAGE_KEY);
      showGate();
      return;
    }
    if (!res.ok) throw new Error("Request failed: " + res.status);
    const { items } = await res.json();
    allItems = items;
    populateFilter(items);
    render(items);
    showApp();
  } catch (err) {
    const errEl = document.getElementById("gateErr");
    errEl.textContent = "Error: " + err.message;
    errEl.style.display = "block";
    showGate();
  }
}

function populateFilter(items) {
  const clients = [...new Set(items.map(i => i.client || "general"))].sort();
  const clientSel = document.getElementById("clientFilter");
  clientSel.innerHTML = '<option value="">All clients</option>' +
    clients.map(c => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join("");

  const courseSel = document.getElementById("filter");

  function applyFilters() {
    const c = clientSel.value;
    const co = courseSel.value;
    let filtered = allItems;
    if (c) filtered = filtered.filter(i => i.client === c);
    if (co) filtered = filtered.filter(i => i.course === co);
    render(filtered);
    updateCourseOptions();
  }

  function updateCourseOptions() {
    const c = clientSel.value;
    const visible = c ? allItems.filter(i => i.client === c) : allItems;
    const courses = [...new Set(visible.map(i => i.course))].sort();
    const previous = courseSel.value;
    courseSel.innerHTML = '<option value="">All courses</option>' +
      courses.map(co => '<option value="' + escapeHtml(co) + '">' + escapeHtml(co) + '</option>').join("");
    if (courses.includes(previous)) courseSel.value = previous;
  }

  updateCourseOptions();
  clientSel.onchange = applyFilters;
  courseSel.onchange = applyFilters;
}

function render(items) {
  const grid = document.getElementById("grid");
  document.getElementById("count").textContent = "(" + items.length + ")";
  if (items.length === 0) {
    grid.innerHTML = '<div class="empty">No submissions yet.</div>';
    return;
  }
  grid.innerHTML = items.map(item => {
    const date = new Date(item.submittedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const meta = '<div class="card-meta">' +
      '<div class="name">' + escapeHtml(item.name) + (item.type === "text" ? ' <span class="badge text">text</span>' : '') + '</div>' +
      (item.email ? '<div class="email">' + escapeHtml(item.email) + '</div>' : '') +
      '<div class="date">' + escapeHtml(date) + ' · ' + escapeHtml(item.client || "general") + ' / ' + escapeHtml(item.course) + '</div>' +
      '</div>';

    if (item.type === "video") {
      return '<div class="card">' +
        '<video controls preload="metadata" src="' + escapeAttr(item.videoUrl) + '"></video>' +
        meta +
        '</div>';
    } else {
      const answers = (item.responses || []).map(r => '' +
        '<div class="answer">' +
        '<div class="answer-q">' + escapeHtml(r.question) + '</div>' +
        '<div>' + escapeHtml(r.answer) + '</div>' +
        '</div>'
      ).join("");
      return '<div class="card">' +
        '<div class="card-text">' + answers + '</div>' +
        meta +
        '</div>';
    }
  }).join("");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

document.getElementById("pw").addEventListener("keydown", e => { if (e.key === "Enter") login(); });

if (localStorage.getItem(STORAGE_KEY)) {
  refresh();
} else {
  showGate();
}
</script>
</body>
</html>`;

// --------------------------------------------------------------
// Branding dashboard (served at GET /config)
// --------------------------------------------------------------
const CONFIG_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StokeReel · Dashboard</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231a1a1a'/%3E%3Cpolygon points='24,16 24,48 52,32' fill='%23c9a961'/%3E%3C/svg%3E">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #faf7f2;
    color: #1a1a1a;
    margin: 0;
    padding: 24px;
    line-height: 1.5;
  }
  h1 { font-family: Georgia, serif; font-weight: normal; margin: 0 0 8px; }
  .sub { color: #6b6b6b; margin: 0 0 24px; font-size: 14px; }
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 420px;
    gap: 28px;
    max-width: 1240px;
    margin: 0 auto;
    align-items: start;
  }
  @media (max-width: 1100px) {
    .layout { grid-template-columns: 1fr; }
    .live-preview-panel { position: static !important; height: 600px !important; }
  }
  .live-preview-panel {
    position: sticky;
    top: 18px;
    border: 1px solid #e5e0d6;
    border-radius: 12px;
    overflow: hidden;
    background: #faf7f2;
    height: calc(100vh - 60px);
    max-height: 880px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 24px -8px rgba(0,0,0,0.08);
  }
  .live-preview-header {
    padding: 10px 14px;
    border-bottom: 1px solid #e5e0d6;
    background: white;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: #6b6b6b;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
  }
  .live-preview-header::before {
    content: "";
    width: 7px; height: 7px; background: #4ade80; border-radius: 50%;
    animation: vt-live-pulse 1.6s infinite;
    box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.6);
  }
  @keyframes vt-live-pulse {
    0% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.6); }
    70% { box-shadow: 0 0 0 6px rgba(74, 222, 128, 0); }
    100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0); }
  }
  .live-preview-iframe {
    width: 100%;
    height: calc(100% - 36px);
    border: 0;
    display: block;
    background: #faf7f2;
  }
  .live-preview-empty {
    padding: 60px 24px;
    text-align: center;
    color: #6b6b6b;
    font-size: 13px;
  }
  .preview-block {
    margin-top: 16px;
    padding: 18px;
    background: #faf7f2;
    border: 1px dashed #c9a961;
    border-radius: 8px;
    position: relative;
  }
  .preview-block::before {
    content: "PREVIEW · how this looks on the page";
    position: absolute;
    top: -10px;
    left: 14px;
    background: #c9a961;
    color: white;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 2px 10px;
    border-radius: 999px;
  }
  .preview-block .pv-headline { font-weight: 400; margin: 0 0 8px; line-height: 1.2; }
  .preview-block .pv-sub { color: #6b6b6b; font-size: 14px; margin: 0 0 14px; }
  .preview-block .pv-input { padding: 9px 11px; border: 1px solid #e5e0d6; border-radius: 6px; background: white; font-size: 13px; color: #6b6b6b; }
  .preview-block .pv-cta { padding: 10px 18px; border-radius: 999px; color: white; border: none; font-weight: 600; font-size: 13px; }
  .preview-block .pv-q {
    background: white; border: 1px solid #e5e0d6; padding: 10px 12px; border-radius: 6px; margin: 6px 0; font-size: 13px;
  }
  .preview-block .pv-q-text { font-weight: 600; }
  .preview-block .pv-q-helper { color: #6b6b6b; font-size: 12px; margin-top: 2px; }
  .preview-block .pv-toggle { font-size: 12px; color: #6b6b6b; text-decoration: underline; margin-top: 12px; display: block; }
  .preview-block .pv-checkmark {
    width: 44px; height: 44px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 10px;
  }
  .preview-block .pv-logo { max-width: 110px; max-height: 44px; object-fit: contain; display: block; margin: 0 auto 14px; }
  .field-preview { margin-top: 6px; min-height: 28px; }
  .fp-pill {
    display: inline-block; padding: 7px 16px; border-radius: 999px; color: white;
    font-weight: 600; font-size: 13px; line-height: 1.2; box-shadow: 0 1px 2px rgba(0,0,0,0.08);
  }
  .fp-secondary {
    display: inline-block; padding: 7px 16px; border-radius: 999px;
    background: transparent; font-weight: 500; font-size: 13px; line-height: 1.2;
  }
  .fp-link { font-size: 13px; text-decoration: underline; }
  .panel { background: white; border: 1px solid #e5e0d6; border-radius: 6px; padding: 24px; }
  .section { margin-bottom: 28px; }
  .section h2 { font-size: 16px; font-weight: 600; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid #e5e0d6; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 13px; color: #6b6b6b; margin-bottom: 4px; }
  .field input, .field textarea, .field select {
    width: 100%; padding: 8px 10px; border: 1px solid #e5e0d6; border-radius: 4px; font-size: 14px; font-family: inherit;
  }
  .field textarea { resize: vertical; min-height: 60px; }
  .field-row { display: grid; grid-template-columns: 80px 1fr; gap: 12px; align-items: center; }
  .field-row input[type=color] { width: 80px; height: 38px; padding: 2px; cursor: pointer; }
  .gate { max-width: 360px; margin: 80px auto; text-align: center; }
  .gate input { width: 100%; padding: 12px; border: 1px solid #e5e0d6; border-radius: 4px; font-size: 16px; margin: 16px 0; }
  button {
    background: #c9a961; color: white; border: none; padding: 10px 20px; border-radius: 4px;
    cursor: pointer; font-size: 14px; font-weight: 500; font-family: inherit;
  }
  button:hover { background: #a88840; }
  button.secondary { background: transparent; color: #6b6b6b; border: 1px solid #e5e0d6; }
  button.secondary:hover { background: #f5f0e6; }
  .top-bar { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px; margin-bottom: 8px; }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; }
  .preview {
    position: sticky; top: 24px;
    border: 1px solid #e5e0d6; border-radius: 6px; overflow: hidden;
    height: 600px; background: white;
  }
  .preview iframe { width: 100%; height: 100%; border: 0; }
  .preview-label { padding: 8px 12px; background: #f5f0e6; border-bottom: 1px solid #e5e0d6; font-size: 12px; color: #6b6b6b; text-transform: uppercase; letter-spacing: 0.5px; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: #1a1a1a; color: white; padding: 12px 18px; border-radius: 4px; font-size: 14px; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .question-block { background: #faf7f2; padding: 12px; border-radius: 4px; margin-bottom: 10px; }
  .question-block label { font-size: 12px; }
  .error { color: #b84a3a; padding: 12px; background: #fdf0ed; border-radius: 4px; }
  .help-text { font-size: 12px; color: #6b6b6b; margin-top: 4px; }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid #e5e0d6; margin-bottom: 24px; }
  .tab {
    background: transparent; border: none; padding: 12px 18px; cursor: pointer;
    font-size: 14px; font-weight: 500; color: #6b6b6b; font-family: inherit;
    border-bottom: 2px solid transparent; margin-bottom: -1px; border-radius: 0;
  }
  .tab:hover { color: #1a1a1a; background: transparent; }
  .tab.active { color: #1a1a1a; border-bottom-color: #c9a961; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .sub-tabs {
    display: flex; gap: 2px; margin-bottom: 24px; flex-wrap: wrap;
    background: white; border: 1px solid #e5e0d6; border-radius: 999px; padding: 4px; width: fit-content;
  }
  .sub-tab {
    background: transparent; border: none; padding: 8px 16px; cursor: pointer;
    font-size: 13px; font-weight: 500; color: #6b6b6b; font-family: inherit;
    border-radius: 999px; transition: background 0.15s, color 0.15s; box-shadow: none;
  }
  .sub-tab:hover { background: #faf7f2; color: #1a1a1a; transform: none; box-shadow: none; }
  .sub-tab.active { background: #1a1a1a; color: white; }
  .sub-tab.active:hover { background: #1a1a1a; color: white; }
  .sub-panel { display: none; }
  .sub-panel.active { display: block; }
  .sub-panel-hint {
    font-size: 13px; color: #6b6b6b; margin: 0 0 16px; padding: 10px 14px;
    background: #fdfbf6; border-left: 3px solid #c9a961; border-radius: 4px;
  }
  .sub-panel-actions {
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    margin-top: 28px; padding-top: 20px; border-top: 1px solid #e5e0d6;
  }
  .sub-panel-actions .hint {
    font-size: 12px; color: #6b6b6b; margin-left: auto;
  }
  .submissions-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; }
  .sub-card { background: white; border: 1px solid #e5e0d6; border-radius: 8px; overflow: hidden; }
  .sub-card video { width: 100%; height: 220px; object-fit: cover; background: #000; display: block; }
  .sub-text { padding: 16px; }
  .sub-text .answer { background: #faf7f2; padding: 10px; border-radius: 4px; margin: 6px 0; font-size: 13px; }
  .sub-text .answer-q { font-weight: 600; font-size: 12px; color: #6b6b6b; margin-bottom: 4px; }
  .sub-meta { padding: 12px 16px; border-top: 1px solid #e5e0d6; font-size: 13px; }
  .sub-meta .name { font-weight: 600; }
  .sub-meta .email { color: #6b6b6b; }
  .sub-meta .date { color: #6b6b6b; font-size: 12px; margin-top: 4px; }
  .sub-badge { display: inline-block; background: #faf7f2; border: 1px solid #e5e0d6; padding: 2px 8px; border-radius: 12px; font-size: 11px; color: #6b6b6b; margin-left: 6px; }
  .sub-badge.text { background: #eef4ff; border-color: #c8d8f4; color: #2a4a8a; }
  .sub-empty { text-align: center; color: #6b6b6b; padding: 60px 20px; grid-column: 1 / -1; }
</style>
</head>
<body>

<div id="gate" class="gate" style="display:none;">
  <h1>Branding</h1>
  <p class="sub">Enter the admin password to customize the recorder.</p>
  <input type="password" id="pw" placeholder="Password" />
  <button onclick="login()">Sign in</button>
  <div id="gateErr" class="error" style="margin-top:12px; display:none;"></div>
</div>

<div id="app" style="display:none;">
  <div class="top-bar">
    <div>
      <h1 style="display:flex; align-items:center; gap:10px;">
        <svg width="32" height="32" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect width="64" height="64" rx="14" fill="#1a1a1a"/>
          <polygon points="24,16 24,48 52,32" fill="#c9a961"/>
        </svg>
        StokeReel
      </h1>
      <p class="sub" id="tabSub">Customize branding or watch your stoked customers — all in one place.</p>
    </div>
    <div class="controls">
      <select id="clientName" style="padding:8px 10px; border:1px solid #e5e0d6; border-radius:4px; min-width:180px;">
        <option value="">— Pick a client —</option>
      </select>
      <select id="courseName" style="padding:8px 10px; border:1px solid #e5e0d6; border-radius:4px; min-width:200px;">
        <option value="">Brand-wide (no funnel override)</option>
      </select>
      <button onclick="logout()" class="secondary">Sign out</button>
    </div>
  </div>

  <div class="tabs">
    <button class="tab active" data-tab="branding" onclick="switchTab('branding')">Branding</button>
    <button class="tab" data-tab="submissions" onclick="switchTab('submissions')">Submissions</button>
  </div>

  <div id="tab-branding" class="tab-panel active">
    <div style="margin-bottom:16px; display:flex; flex-wrap:wrap; gap:8px; align-items:center;">
      <button onclick="loadConfig()" class="secondary">Load</button>
      <button onclick="save()">Save changes</button>
      <button onclick="deleteOverride()" id="deleteBtn" class="secondary" style="display:none; color:#b84a3a; border-color:#b84a3a;">Delete override</button>
      <div id="scopeBadge" style="display:inline-block; margin-left:auto; padding:4px 10px; border-radius:12px; font-size:12px; background:#eef4ff; color:#2a4a8a;"></div>
    </div>

    <div id="shareBox" style="display:none; margin-bottom:20px; padding:18px; background:linear-gradient(135deg,#fdfbf6,#f5efe2); border:1px solid #e5e0d6; border-radius:8px;">
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
        <strong style="font-size:14px;">Share & embed this funnel</strong>
        <span id="shareLabel" style="font-size:12px; color:#6b6b6b;"></span>
      </div>
      <p style="font-size: 12px; color: #6b6b6b; margin: 0 0 14px;">Two ways to use your own domain. The iframe (option 1) is the easiest — works on any site, any domain, zero DNS work.</p>
      <div style="margin-bottom:14px;">
        <label style="display:block; font-size:12px; color:#1a1a1a; margin-bottom:4px; font-weight:600;">⭐ Option 1 — Iframe embed (works on any domain instantly)</label>
        <p style="font-size: 12px; color: #6b6b6b; margin: 0 0 6px;">Paste into any HTML / Custom Code block on your site (GHL, Webflow, WordPress, Squarespace, ClickFunnels, Carrd, anywhere). Your domain shows in the URL bar — no DNS setup needed.</p>
        <div style="display:flex; gap:6px;">
          <input id="shareIframe" type="text" readonly style="flex:1; padding:8px 10px; border:1px solid #e5e0d6; border-radius:4px; font-family:monospace; font-size:12px; background:white;">
          <button onclick="copyShare('shareIframe', this)" class="secondary" style="white-space:nowrap;">Copy</button>
        </div>
      </div>
      <div>
        <label style="display:block; font-size:12px; color:#1a1a1a; margin-bottom:4px; font-weight:600;">Option 2 — Direct shareable URL</label>
        <p style="font-size: 12px; color: #6b6b6b; margin: 0 0 6px;">Send this link directly via email / SMS / DM. By default this uses the worker URL; if you've set a custom domain in Settings, this updates automatically.</p>
        <div style="display:flex; gap:6px;">
          <input id="shareUrl" type="text" readonly style="flex:1; padding:8px 10px; border:1px solid #e5e0d6; border-radius:4px; font-family:monospace; font-size:12px; background:white;">
          <button onclick="copyShare('shareUrl', this)" class="secondary" style="white-space:nowrap;">Copy</button>
        </div>
      </div>
    </div>

  <div class="sub-tabs">
    <button class="sub-tab active" data-subtab="style" onclick="switchSubTab('style')">🎨 Style</button>
    <button class="sub-tab" data-subtab="welcome" onclick="switchSubTab('welcome')">👋 Welcome</button>
    <button class="sub-tab" data-subtab="questions" onclick="switchSubTab('questions')">❓ Questions</button>
    <button class="sub-tab" data-subtab="thankyou" onclick="switchSubTab('thankyou')">🙏 Thank-you</button>
    <button class="sub-tab" data-subtab="buttons" onclick="switchSubTab('buttons')">🔘 Buttons</button>
    <button class="sub-tab" data-subtab="settings" onclick="switchSubTab('settings')">⚙️ Settings</button>
  </div>

  <div class="layout">
    <div class="panel">

      <div class="sub-panel active" data-sub="style">
      <p class="sub-panel-hint">Set your brand identity once. Logo, colors, font — applied across every screen.</p>

      <div class="section">
        <h2>Logo</h2>
        <p class="help-text" style="margin: 0 0 12px;">Shows above the headline on the intro and thank-you screens. PNG, JPG, SVG, or WebP. Max 2MB.</p>
        <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
          <div id="logoPreview" style="width:90px; height:90px; border:1px dashed #e5e0d6; border-radius:8px; display:flex; align-items:center; justify-content:center; background:#faf7f2; font-size:11px; color:#6b6b6b;">No logo</div>
          <div>
            <input type="file" id="logoFileInput" accept="image/png,image/jpeg,image/svg+xml,image/webp" style="display:none;">
            <button type="button" onclick="document.getElementById('logoFileInput').click()" class="secondary">Upload logo</button>
            <button type="button" onclick="removeLogo()" class="secondary" id="logoRemoveBtn" style="display:none; margin-left:6px; color:#b84a3a; border-color:#b84a3a;">Remove</button>
          </div>
        </div>
        <div class="field" style="margin-top:14px;"><label>Or paste an external logo URL</label><input type="text" data-key="logoUrl" placeholder="https://yoursite.com/logo.png"></div>
      </div>

      <div class="section">
        <h2>Quick-start templates</h2>
        <p class="help-text" style="margin: 0 0 12px;">Apply a preset look. You can customize anything after.</p>
        <div id="templatesGrid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:10px;"></div>
      </div>

      <div class="section">
        <h2>Brand colors</h2>
        <div class="field"><label>Primary (buttons, accents)</label>
          <div class="field-row"><input type="color" data-key="brandColor"><input type="text" data-key="brandColor"></div></div>
        <div class="field"><label>Primary hover (slightly darker)</label>
          <div class="field-row"><input type="color" data-key="brandColorDark"><input type="text" data-key="brandColorDark"></div></div>
        <div class="field"><label>Button text (usually white or black)</label>
          <div class="field-row"><input type="color" data-key="buttonTextColor"><input type="text" data-key="buttonTextColor"></div></div>
        <div class="field"><label>Background</label>
          <div class="field-row"><input type="color" data-key="backgroundColor"><input type="text" data-key="backgroundColor"></div></div>
        <div class="field"><label>Body text</label>
          <div class="field-row"><input type="color" data-key="textColor"><input type="text" data-key="textColor"></div></div>
        <div class="field"><label>Muted text (helpers, hints)</label>
          <div class="field-row"><input type="color" data-key="mutedTextColor"><input type="text" data-key="mutedTextColor"></div></div>
        <div class="field"><label>Borders</label>
          <div class="field-row"><input type="color" data-key="borderColor"><input type="text" data-key="borderColor"></div></div>
        <div class="field"><label>Record / error accent</label>
          <div class="field-row"><input type="color" data-key="errorColor"><input type="text" data-key="errorColor"></div></div>
        <div class="field"><label>Heading font</label>
          <select data-key="headingFont" id="headingFontSelect"></select>
          <p class="help-text">Google fonts auto-load on the live recorder. No setup needed.</p>
        </div>
      </div>

      <div class="sub-panel-actions">
        <button onclick="save()">💾 Save changes</button>
        <button onclick="openPreview()" class="secondary">👁 Preview live (no save)</button>
        <span class="hint">Changes apply within 30 seconds</span>
      </div>
      </div><!-- /sub-panel style -->

      <div class="sub-panel" data-sub="welcome">
      <p class="sub-panel-hint">The first thing people see. Get this right and they'll hit record.</p>

      <div class="section">
        <h2>🆕 Start from a template (optional)</h2>
        <p class="help-text" style="margin: 0 0 12px;">Pre-fill the welcome message + 3 questions for your business type. You can edit anything after.</p>
        <div class="field" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <select id="contentPresetSelect" style="flex:1; min-width:260px; padding:10px 12px; border:1px solid #e5e0d6; border-radius:6px; font-size:14px; font-family: inherit;">
            <option value="">— Start blank —</option>
          </select>
          <button onclick="applyContentPreset()" id="applyPresetBtn" disabled>Use this template</button>
        </div>
        <p class="help-text" id="contentPresetDescription" style="margin: 10px 0 0; display:none; padding:10px 12px; background:#fdfbf6; border-left:3px solid #c9a961; border-radius:4px; line-height:1.5;"></p>
        <div id="contentPresetPreview" style="display:none; margin-top:12px;"></div>
      </div>

      <div class="section">
        <h2>Welcome page</h2>
        <div class="field"><label>Headline</label><input type="text" data-key="headline"></div>
        <div class="field"><label>Subheadline</label><textarea data-key="subheadline" rows="3"></textarea></div>
        <div class="field"><label>Intro CTA button label</label><input type="text" data-key="getStartedLabel" placeholder="Get started"><div class="field-preview" data-preview-for="getStartedLabel"></div></div>
        <div class="preview-block" id="previewWelcome"></div>
      </div>
      <div class="sub-panel-actions">
        <button onclick="save()">💾 Save changes</button>
        <button onclick="openPreview()" class="secondary">👁 Preview live (no save)</button>
        <span class="hint">Changes apply within 30 seconds</span>
      </div>
      </div><!-- /sub-panel welcome -->

      <div class="sub-panel" data-sub="thankyou">
      <p class="sub-panel-hint">After they submit. Optionally redirect to a download, scheduling page, or coupon.</p>
      <div class="section">
        <h2>Thank-you screen</h2>
        <div class="field"><label>Thank-you headline</label><input type="text" data-key="thankYouHeader"></div>
        <div class="field"><label>Thank-you body</label><textarea data-key="thankYouBody" rows="2"></textarea></div>
        <div class="field"><label>Signature (optional)</label><input type="text" data-key="signature" placeholder="— Your Name"></div>
        <div class="field"><label>Redirect button label (leave blank to hide)</label><input type="text" data-key="thankYouButtonLabel" placeholder="Download your gift"><div class="field-preview" data-preview-for="thankYouButtonLabel"></div></div>
        <div class="field"><label>Redirect button URL</label><input type="text" data-key="thankYouButtonUrl" placeholder="https://yoursite.com/free-gift"></div>
        <div class="preview-block" id="previewThankYou"></div>
      </div>
      <div class="sub-panel-actions">
        <button onclick="save()">💾 Save changes</button>
        <button onclick="openPreview()" class="secondary">👁 Preview live (no save)</button>
        <span class="hint">Changes apply within 30 seconds</span>
      </div>
      </div><!-- /sub-panel thankyou -->

      <div class="sub-panel" data-sub="buttons">
      <p class="sub-panel-hint">Customize what every button says during the recording flow. Each preview shows the live styled button.</p>
      <div class="section">
        <h2>Recording flow button labels</h2>
        <p class="help-text" style="margin: 0 0 12px;">Customize what every button says during the recording flow. Leave blank to use the default.</p>
        <div class="field"><label>Start recording button</label><input type="text" data-key="startRecordingLabel" placeholder="Start recording"><div class="field-preview" data-preview-for="startRecordingLabel"></div></div>
        <div class="field"><label>Next-question button</label><input type="text" data-key="nextQuestionLabel" placeholder="Next question →"><div class="field-preview" data-preview-for="nextQuestionLabel"></div></div>
        <div class="field"><label>Done / review button (last question)</label><input type="text" data-key="doneReviewLabel" placeholder="Done — review"><div class="field-preview" data-preview-for="doneReviewLabel"></div></div>
        <div class="field"><label>Start-over button (review screen)</label><input type="text" data-key="restartLabel" placeholder="Start over"><div class="field-preview" data-preview-for="restartLabel"></div></div>
        <div class="field"><label>Submit button (review screen)</label><input type="text" data-key="submitLabel" placeholder="Looks good — submit"><div class="field-preview" data-preview-for="submitLabel"></div></div>
        <div class="field"><label>Submit button (text-mode)</label><input type="text" data-key="submitTextLabel" placeholder="Submit"><div class="field-preview" data-preview-for="submitTextLabel"></div></div>
        <div class="field">
          <label style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" data-key="showTypeInsteadLink" style="margin:0;">
            <span>"Type instead" link text</span>
          </label>
          <input type="text" data-key="typeInsteadLabel" placeholder="Prefer to type instead? Click here.">
          <div class="field-preview" data-preview-for="typeInsteadLabel"></div>
        </div>
        <div class="field">
          <label style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" data-key="showSwitchToVideoLink" style="margin:0;">
            <span>"Switch back to video" link text</span>
          </label>
          <input type="text" data-key="switchToVideoLabel" placeholder="Switch to video instead">
          <div class="field-preview" data-preview-for="switchToVideoLabel"></div>
        </div>
      </div>
      <div class="sub-panel-actions">
        <button onclick="save()">💾 Save changes</button>
        <button onclick="openPreview()" class="secondary">👁 Preview live (no save)</button>
        <span class="hint">Changes apply within 30 seconds</span>
      </div>
      </div><!-- /sub-panel buttons -->

      <div class="sub-panel" data-sub="questions">
      <p class="sub-panel-hint">These appear one at a time during recording. URL slug determines which folder submissions land in.</p>
      <div class="section">
        <h2>Questions</h2>
        <div id="questionsContainer"></div>
        <div class="preview-block" id="previewQuestions"></div>
      </div>
      <div class="sub-panel-actions">
        <button onclick="save()">💾 Save changes</button>
        <button onclick="openPreview()" class="secondary">👁 Preview live (no save)</button>
        <span class="hint">Changes apply within 30 seconds</span>
      </div>
      </div><!-- /sub-panel questions -->

      <div class="sub-panel" data-sub="settings">
      <p class="sub-panel-hint">Recording limits, mode toggles, and where to send notifications.</p>

      <div class="section">
        <h2>Behavior</h2>
        <div class="field"><label>Max recording length (seconds)</label><input type="number" data-key="maxRecordingSeconds" min="30" max="900"></div>
        <div class="field" style="display:flex; align-items:flex-start; gap:10px;">
          <input type="checkbox" data-key="allowVideo" id="allowVideoBox" style="margin-top:4px;">
          <label for="allowVideoBox" style="margin:0;">Allow video recording<br><span class="help-text">Shows the camera-based recording flow.</span></label>
        </div>
        <div class="field" style="display:flex; align-items:flex-start; gap:10px;">
          <input type="checkbox" data-key="allowText" id="allowTextBox" style="margin-top:4px;">
          <label for="allowTextBox" style="margin:0;">Allow typed responses<br><span class="help-text">Shows the "Prefer to type instead" option. Uncheck to force video only.</span></label>
        </div>
      </div>

      <div class="section">
        <h2>Notifications</h2>
        <p class="help-text" style="margin: 0 0 12px;">Get pinged on Slack, Discord, Zapier, or any webhook each time a testimonial lands.</p>
        <div class="field"><label>Webhook URL (optional)</label><input type="text" data-key="notifyWebhookUrl" placeholder="https://hooks.slack.com/services/..."></div>
      </div>

      <div class="section">
        <h2>Pretty share URL (optional)</h2>
        <p class="help-text" style="margin: 0 0 12px;">Most people don't need this. The <strong>iframe embed</strong> on the Branding tab already lets you use your own domain — just paste it into a page on your site (any platform, any domain) and the URL bar shows your domain naturally.</p>
        <p class="help-text" style="margin: 0 0 12px;">Only set this up if you want the <em>standalone shareable link</em> (the one you'd paste in an email or SMS) to be on your domain instead of the long <code>*.workers.dev</code> one.</p>
        <div class="field">
          <label>Custom domain (without https://)</label>
          <input type="text" data-key="customDomain" placeholder="recorder.yourdomain.com">
        </div>
        <details style="margin-top:10px;">
          <summary style="cursor:pointer; color:#a88840; font-size:13px; font-weight:600;">▸ How to set this up (Cloudflare DNS path, ~3 min)</summary>
          <div style="margin-top:10px; padding:14px; background:#fdfbf6; border-left:3px solid #c9a961; border-radius:4px; line-height:1.6; font-size:13px; color:#1a1a1a;">
            <p style="margin:0 0 8px;">This path requires your domain to be using Cloudflare for DNS. If it's not, you can either:</p>
            <ul style="margin:0 0 12px; padding-left:22px;">
              <li>Migrate the domain's nameservers to Cloudflare (free, takes ~5 min)</li>
              <li>Or skip this and use the iframe embed instead — works on any domain, no DNS work</li>
            </ul>
            <p style="margin:0 0 6px;"><strong>Cloudflare DNS setup:</strong></p>
            <ol style="margin:0; padding-left:22px;">
              <li>Cloudflare → <strong>Workers &amp; Pages</strong> → click your worker (e.g. <code>stokereel</code>)</li>
              <li><strong>Settings</strong> → <strong>Domains &amp; Routes</strong></li>
              <li><strong>+ Add</strong> → <strong>Custom Domain</strong></li>
              <li>Enter <code>recorder.yourdomain.com</code> → Add</li>
              <li>Wait ~60 sec for SSL provisioning</li>
              <li>Paste the same domain above and Save</li>
            </ol>
            <p style="margin:10px 0 0;"><strong>External DNS (Cloudflare for SaaS):</strong> If you can't move DNS to Cloudflare, this is doable but more involved — let me know and I'll add an automated flow.</p>
          </div>
        </details>
      </div>

      <div class="sub-panel-actions">
        <button onclick="save()">💾 Save changes</button>
        <button onclick="openPreview()" class="secondary">👁 Preview live (no save)</button>
        <span class="hint">Changes apply within 30 seconds</span>
      </div>
      </div><!-- /sub-panel settings -->

    </div><!-- /panel -->

    <div class="live-preview-panel" id="livePreviewPanel">
      <div class="live-preview-header">Live preview · updates as you type</div>
      <iframe id="livePreviewFrame" class="live-preview-iframe" title="Live recorder preview" allow="camera; microphone"></iframe>
      <div class="live-preview-empty" id="livePreviewEmpty" style="display:none;">Pick a client to see the live preview here.</div>
    </div>
  </div>
  </div>

  <div id="tab-submissions" class="tab-panel">
    <div style="margin-bottom:16px; display:flex; flex-wrap:wrap; gap:12px; align-items:center;">
      <span id="subsCount" class="sub" style="margin:0;"></span>
      <select id="subsCourseFilter" style="padding:8px 10px; border:1px solid #e5e0d6; border-radius:4px;">
        <option value="">All funnels</option>
      </select>
      <button onclick="exportCsv()" class="secondary" style="margin-left:auto;">Export CSV</button>
      <button onclick="loadSubmissions()" class="secondary">Refresh</button>
    </div>
    <div id="submissionsGrid" class="submissions-grid"></div>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
const STORAGE_KEY = "vt_admin_pw";
const STORAGE_CLIENT = "vt_config_client";
const STORAGE_COURSE = "vt_config_course";
let currentConfig = null;
let currentScope = null;
let currentInherited = false;

// Curated font palette. Google fonts include the API path needed to load them.
const FONTS = [
  { label: "Georgia (system, classic serif)", css: 'Georgia, "Times New Roman", serif', google: "" },
  { label: "System default (sans)", css: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', google: "" },
  { label: "Helvetica (system, sans)", css: '"Helvetica Neue", Helvetica, Arial, sans-serif', google: "" },
  { label: "Times New Roman (system, serif)", css: '"Times New Roman", Times, serif', google: "" },
  { label: "Playfair Display (Google, elegant serif)", css: '"Playfair Display", Georgia, serif', google: "Playfair+Display:wght@400;600" },
  { label: "Lora (Google, readable serif)", css: '"Lora", Georgia, serif', google: "Lora:wght@400;600" },
  { label: "Merriweather (Google, serif)", css: '"Merriweather", Georgia, serif', google: "Merriweather:wght@400;700" },
  { label: "Fraunces (Google, expressive serif)", css: '"Fraunces", Georgia, serif', google: "Fraunces:wght@400;600" },
  { label: "DM Serif Display (Google, serif)", css: '"DM Serif Display", Georgia, serif', google: "DM+Serif+Display" },
  { label: "Inter (Google, modern sans)", css: '"Inter", system-ui, sans-serif', google: "Inter:wght@400;500;600" },
  { label: "Roboto (Google, clean sans)", css: '"Roboto", system-ui, sans-serif', google: "Roboto:wght@400;500;700" },
  { label: "Poppins (Google, friendly sans)", css: '"Poppins", system-ui, sans-serif', google: "Poppins:wght@400;500;600" },
  { label: "Manrope (Google, tech sans)", css: '"Manrope", system-ui, sans-serif', google: "Manrope:wght@400;500;600" },
  { label: "Space Grotesk (Google, modern sans)", css: '"Space Grotesk", system-ui, sans-serif', google: "Space+Grotesk:wght@400;500;700" },
  { label: "Plus Jakarta Sans (Google, premium sans)", css: '"Plus Jakarta Sans", system-ui, sans-serif', google: "Plus+Jakarta+Sans:wght@400;500;700" }
];

function fontGoogleUrl(googleSpec) {
  if (!googleSpec) return "";
  return "https://fonts.googleapis.com/css2?family=" + googleSpec + "&display=swap";
}

// Template presets — visual styles users can apply with one click.
const TEMPLATES = [
  {
    id: "editorial",
    name: "Editorial",
    swatch: ["#faf7f2", "#c9a961", "#1a1a1a"],
    config: {
      brandColor: "#c9a961", brandColorDark: "#a88840", backgroundColor: "#faf7f2",
      textColor: "#1a1a1a", mutedTextColor: "#6b6b6b", borderColor: "#e5e0d6", errorColor: "#b84a3a",
      headingFont: 'Georgia, "Times New Roman", serif', headingFontGoogleUrl: ""
    }
  },
  {
    id: "modern-mono",
    name: "Modern Mono",
    swatch: ["#ffffff", "#0f172a", "#475569"],
    config: {
      brandColor: "#0f172a", brandColorDark: "#000000", backgroundColor: "#ffffff",
      textColor: "#0f172a", mutedTextColor: "#475569", borderColor: "#e2e8f0", errorColor: "#dc2626",
      headingFont: '"Inter", system-ui, sans-serif', headingFontGoogleUrl: fontGoogleUrl("Inter:wght@400;500;600")
    }
  },
  {
    id: "warm-pastel",
    name: "Warm Pastel",
    swatch: ["#fef6ee", "#e07856", "#3b2a1f"],
    config: {
      brandColor: "#e07856", brandColorDark: "#c0573a", backgroundColor: "#fef6ee",
      textColor: "#3b2a1f", mutedTextColor: "#7a6452", borderColor: "#f1e3d3", errorColor: "#c0392b",
      headingFont: '"Fraunces", Georgia, serif', headingFontGoogleUrl: fontGoogleUrl("Fraunces:wght@400;600")
    }
  },
  {
    id: "premium-gold",
    name: "Premium Gold",
    swatch: ["#0a0a0a", "#d4af37", "#f5f5f5"],
    config: {
      brandColor: "#d4af37", brandColorDark: "#b08c2b", backgroundColor: "#0a0a0a",
      textColor: "#f5f5f5", mutedTextColor: "#a3a3a3", borderColor: "#262626", errorColor: "#ef4444",
      headingFont: '"Playfair Display", Georgia, serif', headingFontGoogleUrl: fontGoogleUrl("Playfair+Display:wght@400;600")
    }
  },
  {
    id: "tech-blue",
    name: "Tech",
    swatch: ["#f8fafc", "#3b82f6", "#0f172a"],
    config: {
      brandColor: "#3b82f6", brandColorDark: "#1d4ed8", backgroundColor: "#f8fafc",
      textColor: "#0f172a", mutedTextColor: "#475569", borderColor: "#e2e8f0", errorColor: "#dc2626",
      headingFont: '"Space Grotesk", system-ui, sans-serif', headingFontGoogleUrl: fontGoogleUrl("Space+Grotesk:wght@400;500;700")
    }
  },
  {
    id: "soft-friendly",
    name: "Soft & Friendly",
    swatch: ["#fdf4ff", "#a855f7", "#3b0764"],
    config: {
      brandColor: "#a855f7", brandColorDark: "#7e22ce", backgroundColor: "#fdf4ff",
      textColor: "#3b0764", mutedTextColor: "#6b21a8", borderColor: "#e9d5ff", errorColor: "#dc2626",
      headingFont: '"Poppins", system-ui, sans-serif', headingFontGoogleUrl: fontGoogleUrl("Poppins:wght@400;500;600")
    }
  },
  {
    id: "earthy",
    name: "Earthy",
    swatch: ["#f5f1ea", "#7c5e3c", "#2d2418"],
    config: {
      brandColor: "#7c5e3c", brandColorDark: "#5a432a", backgroundColor: "#f5f1ea",
      textColor: "#2d2418", mutedTextColor: "#736552", borderColor: "#e0d6c5", errorColor: "#a04040",
      headingFont: '"Lora", Georgia, serif', headingFontGoogleUrl: fontGoogleUrl("Lora:wght@400;600")
    }
  },
  {
    id: "high-contrast",
    name: "High Contrast",
    swatch: ["#ffffff", "#000000", "#525252"],
    config: {
      brandColor: "#000000", brandColorDark: "#262626", backgroundColor: "#ffffff",
      textColor: "#000000", mutedTextColor: "#525252", borderColor: "#d4d4d4", errorColor: "#dc2626",
      headingFont: '"Plus Jakarta Sans", system-ui, sans-serif', headingFontGoogleUrl: fontGoogleUrl("Plus+Jakarta+Sans:wght@400;500;700")
    }
  }
];

function renderTemplates() {
  const grid = document.getElementById("templatesGrid");
  if (!grid) return;
  grid.innerHTML = TEMPLATES.map(t => {
    const swatchHtml = t.swatch.map(c => '<span style="display:inline-block; width:18px; height:18px; border-radius:4px; background:' + c + '; border:1px solid rgba(0,0,0,0.06);"></span>').join('');
    return '<button type="button" data-template-id="' + escapeAttr(t.id) + '" class="secondary" style="display:flex; flex-direction:column; align-items:flex-start; padding:10px 12px; gap:8px; text-align:left; height:auto;">' +
      '<div style="display:flex; gap:4px;">' + swatchHtml + '</div>' +
      '<span style="font-size:13px; font-weight:500;">' + escapeHtml(t.name) + '</span>' +
      '</button>';
  }).join('');
  grid.querySelectorAll("[data-template-id]").forEach(btn => {
    btn.addEventListener("click", () => applyTemplate(btn.getAttribute("data-template-id")));
  });
}

function refreshLogoPreview() {
  const url = document.querySelector('input[data-key="logoUrl"]').value.trim();
  const preview = document.getElementById("logoPreview");
  const removeBtn = document.getElementById("logoRemoveBtn");
  if (url) {
    preview.innerHTML = '<img src="' + escapeAttr(url) + '" style="max-width:100%; max-height:100%; object-fit:contain;">';
    removeBtn.style.display = "inline-block";
  } else {
    preview.innerHTML = "No logo";
    removeBtn.style.display = "none";
  }
}

async function uploadLogo(file) {
  const pw = localStorage.getItem(STORAGE_KEY);
  const clientRaw = document.getElementById("clientName").value;
  const client = clientRaw && clientRaw !== NEW_OPTION ? clientRaw : "";
  if (!pw || !client) {
    toast("Pick a client first.");
    return;
  }
  const fd = new FormData();
  fd.append("password", pw);
  fd.append("client", client);
  fd.append("file", file);
  try {
    const res = await fetch("/admin/upload-logo", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ("Upload failed: " + res.status));
    const input = document.querySelector('input[data-key="logoUrl"]');
    input.value = data.logoUrl;
    if (currentConfig) currentConfig.logoUrl = data.logoUrl;
    refreshLogoPreview();
    refreshPreview();
    toast("Logo uploaded. Hit Save to publish.");
  } catch (err) {
    toast("Error: " + err.message);
  }
}

function removeLogo() {
  const input = document.querySelector('input[data-key="logoUrl"]');
  input.value = "";
  if (currentConfig) currentConfig.logoUrl = "";
  refreshLogoPreview();
  refreshPreview();
}

function applyTemplate(id) {
  const t = TEMPLATES.find(x => x.id === id);
  if (!t || !currentConfig) return;
  // Merge template visuals into currentConfig (preserves headlines, copy, questions)
  currentConfig = { ...currentConfig, ...t.config };
  // Re-populate form fields that might have changed
  document.querySelectorAll("[data-key]").forEach(el => {
    const key = el.getAttribute("data-key");
    if (key === "questions") return;
    if (currentConfig[key] !== undefined) el.value = currentConfig[key];
  });
  refreshPreview();
  toast("Applied template: " + t.name + ". Hit Save to publish.");
}

function findFontGoogleUrl(cssValue) {
  const f = FONTS.find(x => x.css === cssValue);
  return f ? fontGoogleUrl(f.google) : "";
}

function populateFontSelect() {
  const sel = document.getElementById("headingFontSelect");
  if (!sel) return;
  sel.innerHTML = FONTS.map(f =>
    '<option value="' + escapeAttr(f.css) + '">' + escapeHtml(f.label) + '</option>'
  ).join("");
}

function showGate() { document.getElementById("gate").style.display = "block"; document.getElementById("app").style.display = "none"; }
function showApp() { document.getElementById("gate").style.display = "none"; document.getElementById("app").style.display = "block"; }

async function login() {
  const pw = document.getElementById("pw").value;
  if (!pw) return;
  localStorage.setItem(STORAGE_KEY, pw);
  await loadConfig();
}

function logout() {
  localStorage.removeItem(STORAGE_KEY);
  showGate();
}

function slugify(s) { return (s || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, ""); }

const NEW_OPTION = "__add_new__";

// Content presets — pre-fill welcome message + 3 questions per business type.
// Reduces blank-page friction for first-time users.
const CONTENT_PRESETS = [
  {
    id: "coach-transformation",
    label: "Coach / Course (transformation story)",
    description: "Best for course creators, coaches, and educators. Pulls out the before/after arc that sells.",
    welcome: {
      title: "Share your story :)",
      subtitle: 'Three quick questions in one short video. Hit record, answer them one after another, tap "Next question" as you go.'
    },
    questions: [
      { text: "What were you struggling with before you joined?", helper: "What was actually frustrating you?" },
      { text: "What's the biggest thing that's changed for you?", helper: "Be specific — what shifted, what's different now?" },
      { text: "What would you tell someone who's on the fence?", helper: "Imagine a friend asked if they should buy. What would you say?" }
    ]
  },
  {
    id: "saas-problem-solution",
    label: "SaaS / Software (problem → solution)",
    description: "For tools and software. Frames the testimonial around switching, ROI, and who should use it.",
    welcome: {
      title: "Tell us how it's going :)",
      subtitle: 'Three quick questions in one short video. Hit record, answer them one after another, tap "Next question" as you go.'
    },
    questions: [
      { text: "What were you using (or not using) before you found us?", helper: "What was the workaround that wasn't working?" },
      { text: "What changed once you started using it?", helper: "Time saved, headaches gone, results — whatever stands out." },
      { text: "Who should try this?", helper: "Picture the person this would help most. Describe them." }
    ]
  },
  {
    id: "service-referral",
    label: "Service Business (referral-focused)",
    description: "For agencies, consultants, contractors, freelancers. Designed to generate word-of-mouth language.",
    welcome: {
      title: "Quick favor :)",
      subtitle: 'Three quick questions in one short video. Hit record, answer them one after another, tap "Next question" as you go.'
    },
    questions: [
      { text: "What made you decide to hire us in the first place?", helper: "What were you weighing? What tipped the scales?" },
      { text: "What surprised you about working with us?", helper: "Something you didn't expect — good or unexpected." },
      { text: "Who do you know who needs this?", helper: "Picture them in your head. What's their situation?" }
    ]
  },
  {
    id: "quick-endorsement",
    label: "Quick & Casual (low friction)",
    description: "Two short questions for when you just need warm bodies on camera. Highest completion rate.",
    welcome: {
      title: "Got 30 seconds? :)",
      subtitle: "Two quick questions, one short video. Hit record and just talk like you're texting a friend."
    },
    questions: [
      { text: "What do you love about it?", helper: "First thing that comes to mind. Don't overthink it." },
      { text: "What would you tell a friend about us?", helper: "Real talk — how would you describe this to someone you know?" }
    ]
  },
  {
    id: "sales-page-objections",
    label: "Sales Page (objection crusher)",
    description: "Surgically designed for sales pages. Gets buyers naming the exact fears your future buyers have.",
    welcome: {
      title: "Help future buyers :)",
      subtitle: 'Three quick questions in one short video. Hit record, answer them one after another, tap "Next question" as you go.'
    },
    questions: [
      { text: "What almost stopped you from buying?", helper: "The doubt, the price, the timing — what made you hesitate?" },
      { text: "What convinced you to pull the trigger?", helper: "What flipped the switch from 'maybe' to 'yes'?" },
      { text: "Was it worth it?", helper: "Looking back now — would you do it again?" }
    ]
  },
  {
    id: "ecommerce-product",
    label: "Ecommerce / Physical Product",
    description: "For physical goods. Captures product quality, real-world use, and recommendation language.",
    welcome: {
      title: "How's it holding up? :)",
      subtitle: 'Three quick questions in one short video. Hit record, answer them one after another, tap "Next question" as you go.'
    },
    questions: [
      { text: "What were you looking for when you found us?", helper: "What problem were you trying to solve? What had you tried?" },
      { text: "How's the product been so far?", helper: "Quality, how you use it, anything that stood out." },
      { text: "Would you recommend it? To who?", helper: "Who's the kind of person this would be perfect for?" }
    ]
  },
  {
    id: "local-business",
    label: "Local / Brick-and-mortar",
    description: "For restaurants, gyms, salons, shops. Captures vibe, staff, and repeat-customer energy.",
    welcome: {
      title: "Tell us about your visit :)",
      subtitle: 'Three quick questions in one short video. Hit record, answer them one after another, tap "Next question" as you go.'
    },
    questions: [
      { text: "What brought you in the first time?", helper: "How'd you hear about us? What were you hoping for?" },
      { text: "What keeps you coming back?", helper: "The food, the people, the vibe — what is it?" },
      { text: "Who have you told about us?", helper: "Anyone you've mentioned us to lately?" }
    ]
  },
  {
    id: "wellness-health",
    label: "Health & Wellness",
    description: "For coaches, gyms, supplements, therapy, programs. Emotional + physical transformation language.",
    welcome: {
      title: "Share where you're at :)",
      subtitle: 'Three quick questions in one short video. Hit record, answer them one after another, tap "Next question" as you go.'
    },
    questions: [
      { text: "Where were you at when you started?", helper: "How were you feeling? What wasn't working?" },
      { text: "What's different now?", helper: "Physically, mentally, day-to-day — what's changed?" },
      { text: "What would you tell someone who's hesitating?", helper: "Someone in the spot you used to be in. What would you say?" }
    ]
  }
];

function populateContentPresets() {
  const sel = document.getElementById("contentPresetSelect");
  if (!sel || sel.dataset.populated === "1") return;
  sel.innerHTML = '<option value="">— Start blank —</option>' +
    CONTENT_PRESETS.map(p => '<option value="' + escapeAttr(p.id) + '">' + escapeHtml(p.label) + '</option>').join("");
  sel.dataset.populated = "1";
  sel.addEventListener("change", () => {
    const preset = CONTENT_PRESETS.find(p => p.id === sel.value);
    const descEl = document.getElementById("contentPresetDescription");
    const previewEl = document.getElementById("contentPresetPreview");
    const btn = document.getElementById("applyPresetBtn");
    if (preset) {
      if (descEl) { descEl.textContent = preset.description; descEl.style.display = "block"; }
      if (btn) btn.disabled = false;
      if (previewEl) {
        const questionsHtml = preset.questions.map((q, i) =>
          '<div style="margin-top:8px; padding:10px 12px; background:#faf7f2; border-radius:5px; border:1px solid #e5e0d6;">' +
          '<div style="font-weight:600; color:#1a1a1a;">Q' + (i + 1) + '. ' + escapeHtml(q.text) + '</div>' +
          (q.helper ? '<div style="color:#6b6b6b; font-size:12px; margin-top:3px;">' + escapeHtml(q.helper) + '</div>' : '') +
          '</div>'
        ).join("");
        previewEl.innerHTML =
          '<div style="padding:16px; background:white; border:1px dashed #c9a961; border-radius:8px; position:relative;">' +
          '<div style="position:absolute; top:-9px; left:14px; background:#c9a961; color:white; font-size:10px; font-weight:700; letter-spacing:0.06em; padding:2px 9px; border-radius:999px;">PREVIEW</div>' +
          '<div style="margin-bottom:12px;">' +
          '<div style="font-weight:700; color:#6b6b6b; font-size:10px; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:4px;">Welcome title</div>' +
          '<div style="font-family:Georgia,serif; font-size:18px;">' + escapeHtml(preset.welcome.title) + '</div>' +
          '</div>' +
          '<div style="margin-bottom:14px;">' +
          '<div style="font-weight:700; color:#6b6b6b; font-size:10px; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:4px;">Welcome subtitle</div>' +
          '<div style="color:#1a1a1a; font-size:14px; line-height:1.5;">' + escapeHtml(preset.welcome.subtitle) + '</div>' +
          '</div>' +
          '<div>' +
          '<div style="font-weight:700; color:#6b6b6b; font-size:10px; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:4px;">Questions (' + preset.questions.length + ')</div>' +
          questionsHtml +
          '</div>' +
          '</div>';
        previewEl.style.display = "block";
      }
    } else {
      if (descEl) descEl.style.display = "none";
      if (previewEl) previewEl.style.display = "none";
      if (btn) btn.disabled = true;
    }
  });
}

function applyContentPreset() {
  const sel = document.getElementById("contentPresetSelect");
  if (!sel) return;
  const preset = CONTENT_PRESETS.find(p => p.id === sel.value);
  if (!preset) return;

  // Confirmation guard if there's existing content the customer might lose
  const headlineEl = document.querySelector('input[data-key="headline"]');
  const subheadEl = document.querySelector('textarea[data-key="subheadline"]');
  const headline = headlineEl ? headlineEl.value.trim() : "";
  const subhead = subheadEl ? subheadEl.value.trim() : "";
  const hasQuestionContent = (currentConfig && currentConfig.questions || []).some(q => q && q.text && q.text.trim());
  if (headline || subhead || hasQuestionContent) {
    if (!confirm("This will replace your current welcome message and questions. Continue?")) return;
  }

  // Apply welcome
  if (headlineEl) headlineEl.value = preset.welcome.title;
  if (subheadEl) subheadEl.value = preset.welcome.subtitle;

  // Replace questions wholesale
  currentConfig.questions = preset.questions.map(q => ({ text: q.text, helper: q.helper || "" }));
  renderQuestions();

  refreshPreview();
  toast("✨ Template applied: " + preset.label);

  // Switch to welcome sub-tab if not already there, scroll to welcome section
  switchSubTab("welcome");
  setTimeout(() => {
    const target = document.querySelector('[data-sub="welcome"] .section:nth-of-type(2)');
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 100);
}

async function fetchClients() {
  const pw = localStorage.getItem(STORAGE_KEY);
  if (!pw) return [];
  try {
    const res = await fetch("/config/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw })
    });
    if (!res.ok) return [];
    const { clients } = await res.json();
    return clients || [];
  } catch { return []; }
}

async function fetchFunnels(client) {
  const pw = localStorage.getItem(STORAGE_KEY);
  if (!pw || !client) return [];
  try {
    const res = await fetch("/config/funnels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw, client })
    });
    if (!res.ok) return [];
    const { funnels } = await res.json();
    return funnels || [];
  } catch { return []; }
}

function populateClientSelect(clients, selected) {
  const sel = document.getElementById("clientName");
  const wanted = selected || sel.value || "";
  const opts = ['<option value="">— Pick a client —</option>'];
  for (const c of clients) {
    opts.push('<option value="' + escapeAttr(c) + '"' + (c === wanted ? ' selected' : '') + '>' + escapeHtml(c) + '</option>');
  }
  opts.push('<option value="' + NEW_OPTION + '">+ Add new client…</option>');
  sel.innerHTML = opts.join("");
}

function populateFunnelSelect(funnels, selected) {
  const sel = document.getElementById("courseName");
  const wanted = selected || sel.value || "";
  const opts = ['<option value="">Brand-wide (no funnel override)</option>'];
  for (const f of funnels) {
    opts.push('<option value="' + escapeAttr(f) + '"' + (f === wanted ? ' selected' : '') + '>' + escapeHtml(f) + '</option>');
  }
  opts.push('<option value="' + NEW_OPTION + '">+ Add new funnel override…</option>');
  sel.innerHTML = opts.join("");
}

async function refreshClientList(selectedClient) {
  const clients = await fetchClients();
  populateClientSelect(clients, selectedClient);
}

async function refreshFunnelList(client, selectedFunnel) {
  const funnels = await fetchFunnels(client);
  populateFunnelSelect(funnels, selectedFunnel);
}

function persistSelection() {
  const clientRaw = document.getElementById("clientName").value;
  const courseRaw = document.getElementById("courseName").value;
  const client = clientRaw && clientRaw !== NEW_OPTION ? clientRaw : "";
  const course = courseRaw && courseRaw !== NEW_OPTION ? courseRaw : "";
  if (client) localStorage.setItem(STORAGE_CLIENT, client);
  if (course) localStorage.setItem(STORAGE_COURSE, course);
  else localStorage.removeItem(STORAGE_COURSE);
}

function handleClientChange() {
  const sel = document.getElementById("clientName");
  if (sel.value === NEW_OPTION) {
    const raw = prompt("Enter a slug for the new client (e.g. lotilabs):");
    const slug = slugify(raw || "");
    if (!slug) {
      sel.value = "";
      return;
    }
    // Insert option and select it
    const opt = document.createElement("option");
    opt.value = slug;
    opt.textContent = slug;
    sel.insertBefore(opt, sel.querySelector(\`option[value="\${NEW_OPTION}"]\`));
    sel.value = slug;
  }
  // When client changes, reset funnel and refresh its list
  document.getElementById("courseName").value = "";
  refreshFunnelList(sel.value, "");
  updateScopeBadge();
  reloadLivePreview();
  persistSelection();
}

function handleFunnelChange() {
  const sel = document.getElementById("courseName");
  if (sel.value === NEW_OPTION) {
    const raw = prompt("Enter a slug for the new funnel override (e.g. play-what-you-hear-testimonial):");
    const slug = slugify(raw || "");
    if (!slug) {
      sel.value = "";
      return;
    }
    const opt = document.createElement("option");
    opt.value = slug;
    opt.textContent = slug;
    sel.insertBefore(opt, sel.querySelector(\`option[value="\${NEW_OPTION}"]\`));
    sel.value = slug;
  }
  updateScopeBadge();
  reloadLivePreview();
  persistSelection();
}

async function loadConfig() {
  const pw = localStorage.getItem(STORAGE_KEY);
  if (!pw) { showGate(); return; }

  const clientInput = document.getElementById("clientName");
  const courseInput = document.getElementById("courseName");
  // Selects may have a sentinel value if the user didn't actually pick yet
  let clientRaw = clientInput.value && clientInput.value !== NEW_OPTION ? clientInput.value : (localStorage.getItem(STORAGE_CLIENT) || "");
  let courseRaw = courseInput.value && courseInput.value !== NEW_OPTION ? courseInput.value : "";
  let client = slugify(clientRaw) || "general";
  let course = slugify(courseRaw) || null;
  // Make sure selects reflect the chosen values (refreshing options if needed)
  await refreshClientList(client);
  await refreshFunnelList(client, course || "");
  clientInput.value = client;
  courseInput.value = course || "";
  localStorage.setItem(STORAGE_CLIENT, client);
  if (course) localStorage.setItem(STORAGE_COURSE, course);
  else localStorage.removeItem(STORAGE_COURSE);

  document.getElementById("gateErr").style.display = "none";
  try {
    const res = await fetch("/config/get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw, client, course })
    });
    if (res.status === 401) {
      const errEl = document.getElementById("gateErr");
      errEl.textContent = "Wrong password.";
      errEl.style.display = "block";
      localStorage.removeItem(STORAGE_KEY);
      showGate();
      return;
    }
    if (!res.ok) throw new Error("Request failed: " + res.status);
    const { config, scope, inherited } = await res.json();
    currentConfig = config;
    currentScope = scope;
    currentInherited = inherited;
    updateScopeBadge();
    populateForm(config);
    refreshPreview();
    reloadLivePreview();
    showApp();
  } catch (err) {
    const errEl = document.getElementById("gateErr");
    errEl.textContent = "Error: " + err.message;
    errEl.style.display = "block";
    showGate();
  }
}

function updateShareBox() {
  const clientRaw = document.getElementById("clientName").value;
  const courseRaw = document.getElementById("courseName").value;
  const client = clientRaw && clientRaw !== NEW_OPTION ? clientRaw.trim() : "";
  const course = courseRaw && courseRaw !== NEW_OPTION ? courseRaw.trim() : "";
  const box = document.getElementById("shareBox");
  if (!client || !course) { box.style.display = "none"; return; }
  // Prefer the customer's custom domain if they set one; fall back to *.workers.dev origin
  const domainInput = document.querySelector('input[data-key="customDomain"]');
  let rawDomain = (domainInput && domainInput.value || "").trim();
  if (rawDomain.indexOf("https://") === 0) rawDomain = rawDomain.slice(8);
  else if (rawDomain.indexOf("http://") === 0) rawDomain = rawDomain.slice(7);
  while (rawDomain.endsWith("/")) rawDomain = rawDomain.slice(0, -1);
  const baseUrl = rawDomain ? "https://" + rawDomain : window.location.origin;
  const url = baseUrl + "/r/" + encodeURIComponent(client) + "/" + encodeURIComponent(course);
  document.getElementById("shareUrl").value = url;
  document.getElementById("shareIframe").value =
    '<iframe src="' + url + '" allow="camera; microphone" style="width:100%;min-height:90vh;border:0;display:block;"></iframe>';
  document.getElementById("shareLabel").textContent = client + " / " + course;
  box.style.display = "block";
}

async function copyShare(inputId, btn) {
  const input = document.getElementById(inputId);
  try {
    await navigator.clipboard.writeText(input.value);
    const originalText = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = originalText; }, 1500);
  } catch {
    input.select();
    document.execCommand("copy");
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 1500);
  }
}

function updateScopeBadge() {
  updateShareBox();
  const badge = document.getElementById("scopeBadge");
  const deleteBtn = document.getElementById("deleteBtn");
  const courseRaw = document.getElementById("courseName").value;
  const course = courseRaw && courseRaw !== NEW_OPTION ? courseRaw.trim() : "";
  if (course) {
    if (currentInherited) {
      badge.textContent = "Editing: NEW funnel override (currently inheriting brand-wide settings)";
      badge.style.background = "#fff7e6";
      badge.style.color = "#8a5a00";
      deleteBtn.style.display = "none";
    } else {
      badge.textContent = "Editing: funnel override → " + course;
      badge.style.background = "#eef4ff";
      badge.style.color = "#2a4a8a";
      deleteBtn.style.display = "inline-block";
    }
  } else {
    badge.textContent = "Editing: brand-wide defaults";
    badge.style.background = "#f0f4ee";
    badge.style.color = "#3a6a3a";
    deleteBtn.style.display = "none";
  }
}

async function deleteOverride() {
  const pw = localStorage.getItem(STORAGE_KEY);
  const client = document.getElementById("clientName").value.trim();
  const course = document.getElementById("courseName").value.trim();
  if (!pw || !client || !course) return;
  if (!confirm("Delete this funnel override? It will fall back to your brand-wide defaults.")) return;
  try {
    const res = await fetch("/config/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw, client, course })
    });
    if (!res.ok) throw new Error("Delete failed: " + res.status);
    toast("Override deleted. This funnel now uses brand-wide settings.");
    document.getElementById("courseName").value = "";
    localStorage.removeItem(STORAGE_COURSE);
    await loadConfig();
  } catch (err) {
    toast("Error: " + err.message);
  }
}

function populateForm(config) {
  populateFontSelect();
  renderTemplates();
  populateContentPresets();
  // Color pickers + paired text inputs share the same data-key
  document.querySelectorAll("[data-key]").forEach(el => {
    const key = el.getAttribute("data-key");
    if (key === "questions") return;
    if (el.type === "checkbox") {
      el.checked = config[key] !== false; // default true if undefined
    } else if (config[key] !== undefined) {
      el.value = config[key];
    }
  });

  // Wire up paired color/hex inputs and live updates
  document.querySelectorAll("[data-key]").forEach(el => {
    el.addEventListener("input", () => {
      const key = el.getAttribute("data-key");
      const value = el.value;
      document.querySelectorAll(\`[data-key="\${key}"]\`).forEach(other => {
        if (other !== el) other.value = value;
      });
      refreshPreview();
    });
  });

  if (!currentConfig.questions || !currentConfig.questions.length) {
    currentConfig.questions = [{ text: "", helper: "" }];
  }
  renderQuestions();
  refreshLogoPreview();
}

function renderQuestions() {
  const container = document.getElementById("questionsContainer");
  const questions = currentConfig.questions || [];
  const blocks = questions.map((q, i) => {
    const removeBtn = questions.length > 1
      ? \`<button type="button" onclick="removeQuestion(\${i})" class="secondary" style="padding:4px 10px;font-size:12px;color:#b84a3a;border-color:#b84a3a;">Remove</button>\`
      : '';
    const upBtn = i > 0
      ? \`<button type="button" onclick="moveQuestion(\${i},-1)" class="secondary" style="padding:4px 8px;font-size:12px;">↑</button>\`
      : '';
    const downBtn = i < questions.length - 1
      ? \`<button type="button" onclick="moveQuestion(\${i},1)" class="secondary" style="padding:4px 8px;font-size:12px;">↓</button>\`
      : '';
    return \`
      <div class="question-block">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:6px;">
          <strong style="font-size:13px;">Question \${i + 1}</strong>
          <div style="display:flex;gap:6px;">\${upBtn}\${downBtn}\${removeBtn}</div>
        </div>
        <div class="field"><label>Question text</label><input type="text" data-q="\${i}" data-qkey="text" value="\${escapeAttr(q.text || '')}"></div>
        <div class="field"><label>Helper text (optional)</label><input type="text" data-q="\${i}" data-qkey="helper" value="\${escapeAttr(q.helper || '')}"></div>
      </div>
    \`;
  }).join("");
  container.innerHTML = blocks + \`<button type="button" onclick="addQuestion()" style="margin-top:8px;">+ Add question</button>\`;

  document.querySelectorAll("[data-q]").forEach(el => {
    el.addEventListener("input", () => {
      syncQuestionsFromForm();
      refreshPreview();
    });
  });
}

function syncQuestionsFromForm() {
  const next = [];
  document.querySelectorAll("[data-q]").forEach(el => {
    const i = Number(el.getAttribute("data-q"));
    const k = el.getAttribute("data-qkey");
    if (!next[i]) next[i] = { text: "", helper: "" };
    next[i][k] = el.value;
  });
  currentConfig.questions = next.filter(Boolean);
}

function addQuestion() {
  syncQuestionsFromForm();
  if (!currentConfig.questions) currentConfig.questions = [];
  currentConfig.questions.push({ text: "", helper: "" });
  renderQuestions();
  refreshPreview();
}

function removeQuestion(i) {
  syncQuestionsFromForm();
  currentConfig.questions.splice(i, 1);
  if (currentConfig.questions.length === 0) {
    currentConfig.questions = [{ text: "", helper: "" }];
  }
  renderQuestions();
  refreshPreview();
}

function moveQuestion(i, dir) {
  syncQuestionsFromForm();
  const arr = currentConfig.questions;
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  renderQuestions();
  refreshPreview();
}

function readForm() {
  const config = JSON.parse(JSON.stringify(currentConfig)) || {};
  document.querySelectorAll("[data-key]").forEach(el => {
    const key = el.getAttribute("data-key");
    if (key === "questions") return;
    if (el.type === "color") return; // skip colors (text input has the same key)
    if (el.type === "checkbox") {
      config[key] = el.checked;
      return;
    }
    let val = el.value;
    if (el.type === "number") val = Number(val);
    config[key] = val;
  });
  // Re-read colors from text inputs (color picker is paired)
  ["brandColor","brandColorDark","buttonTextColor","backgroundColor","textColor","mutedTextColor","borderColor","errorColor"].forEach(k => {
    const textInputs = document.querySelectorAll(\`input[type=text][data-key="\${k}"]\`);
    if (textInputs[0]) config[k] = textInputs[0].value;
  });
  // Derive Google Font URL from chosen heading font
  config.headingFontGoogleUrl = findFontGoogleUrl(config.headingFont);

  syncQuestionsFromForm();
  config.questions = (currentConfig.questions || []).filter(q => q && q.text);

  return config;
}

async function save() {
  const pw = localStorage.getItem(STORAGE_KEY);
  const clientRaw = document.getElementById("clientName").value;
  const courseRaw = document.getElementById("courseName").value;
  const client = clientRaw && clientRaw !== NEW_OPTION ? clientRaw.trim() : "";
  const course = courseRaw && courseRaw !== NEW_OPTION ? courseRaw.trim() : null;
  if (!pw || !client) {
    toast("Pick a client first.");
    return;
  }
  const config = readForm();
  try {
    const res = await fetch("/config/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw, client, course, config })
    });
    if (!res.ok) throw new Error("Save failed: " + res.status);
    currentConfig = config;
    currentInherited = false;
    currentScope = course ? "course" : "client";
    updateScopeBadge();
    toast(course ? ("Saved override for " + course + ". Live now.") : "Saved brand-wide settings. Live now.");
    // Persist active selection so reload picks up the same client/course
    localStorage.setItem(STORAGE_CLIENT, client);
    if (course) localStorage.setItem(STORAGE_COURSE, course);
    else localStorage.removeItem(STORAGE_COURSE);
    // Refresh selects so newly created clients/funnels show up next time
    await refreshClientList(client);
    await refreshFunnelList(client, course || "");
  } catch (err) {
    toast("Error: " + err.message);
  }
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2000);
}

function refreshPreview() {
  const cfg = readForm();
  loadDashboardFont(cfg.headingFontGoogleUrl);
  renderWelcomePreview(cfg);
  renderQuestionsPreview(cfg);
  renderThankYouPreview(cfg);
  renderButtonPreviews(cfg);
  pushLivePreviewConfig(cfg);
}

function getPreviewClientCourse() {
  const clientRaw = document.getElementById("clientName").value;
  const courseRaw = document.getElementById("courseName").value;
  const client = clientRaw && clientRaw !== NEW_OPTION ? clientRaw : "";
  const course = courseRaw && courseRaw !== NEW_OPTION ? courseRaw : "preview";
  return { client, course };
}

function reloadLivePreview() {
  const iframe = document.getElementById("livePreviewFrame");
  const empty = document.getElementById("livePreviewEmpty");
  if (!iframe) return;
  const { client, course } = getPreviewClientCourse();
  if (!client) {
    iframe.style.display = "none";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";
  iframe.style.display = "block";
  // Stash current form state for the iframe to read on initial load
  try {
    const config = readForm();
    localStorage.setItem("vt_preview_" + client + "_" + course, JSON.stringify(config));
  } catch {}
  const newPath = "/r/" + encodeURIComponent(client) + "/" + encodeURIComponent(course) + "?preview=1";
  if (iframe.getAttribute("src") !== newPath) {
    iframe.setAttribute("src", newPath);
  }
}

function pushLivePreviewConfig(cfg) {
  const iframe = document.getElementById("livePreviewFrame");
  if (!iframe || !iframe.contentWindow) return;
  const { client, course } = getPreviewClientCourse();
  if (!client) return;
  // Keep localStorage in sync so iframe reload picks up latest
  try {
    localStorage.setItem("vt_preview_" + client + "_" + course, JSON.stringify(cfg));
  } catch {}
  // Live push to the iframe — no reload, instant update
  try {
    iframe.contentWindow.postMessage({ type: "VT_CONFIG_UPDATE", config: cfg }, "*");
  } catch {}
}

function renderButtonPreviews(c) {
  const styles = {
    getStartedLabel:     { type: "pill",      bg: c.brandColor },
    startRecordingLabel: { type: "pill",      bg: c.errorColor },
    nextQuestionLabel:   { type: "pill",      bg: c.brandColor },
    doneReviewLabel:     { type: "pill",      bg: c.textColor },
    restartLabel:        { type: "secondary", color: c.mutedTextColor, border: c.borderColor },
    submitLabel:         { type: "pill",      bg: c.brandColor },
    submitTextLabel:     { type: "pill",      bg: c.brandColor },
    typeInsteadLabel:    { type: "link",      color: c.mutedTextColor },
    switchToVideoLabel:  { type: "link",      color: c.mutedTextColor },
    thankYouButtonLabel: { type: "pill",      bg: c.brandColor }
  };
  document.querySelectorAll("[data-preview-for]").forEach(el => {
    const key = el.getAttribute("data-preview-for");
    let value = c[key];
    // If the user has cleared the field, fall back to the placeholder so they
    // can still see what the default button will look like.
    if (!value) {
      const input = document.querySelector('input[data-key="' + key + '"]');
      if (input && input.placeholder) value = input.placeholder;
    }
    const style = styles[key];
    if (!value || !style) { el.innerHTML = ""; return; }
    if (style.type === "pill") {
      el.innerHTML = '<span class="fp-pill" style="background:' + escapeAttr(style.bg) + '; color:' + escapeAttr(c.buttonTextColor || "#ffffff") + ';">' + escapeHtml(value) + '</span>';
    } else if (style.type === "secondary") {
      el.innerHTML = '<span class="fp-secondary" style="color:' + escapeAttr(style.color) + '; border:1px solid ' + escapeAttr(style.border) + ';">' + escapeHtml(value) + '</span>';
    } else if (style.type === "link") {
      el.innerHTML = '<span class="fp-link" style="color:' + escapeAttr(style.color) + ';">' + escapeHtml(value) + '</span>';
    }
  });
}

function loadDashboardFont(url) {
  if (!url) return;
  if (document.querySelector('link[data-vt-dash-font="' + url + '"]')) return;
  document.querySelectorAll('link[data-vt-dash-font]').forEach(l => l.remove());
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  link.setAttribute("data-vt-dash-font", url);
  document.head.appendChild(link);
}

function renderWelcomePreview(c) {
  const el = document.getElementById("previewWelcome");
  if (!el) return;
  const showText = c.allowText !== false && c.allowVideo !== false;
  const logo = c.logoUrl ? '<img class="pv-logo" src="' + escapeAttr(c.logoUrl) + '">' : '';
  el.style.background = c.backgroundColor;
  el.style.color = c.textColor;
  el.innerHTML = logo +
    '<h2 class="pv-headline" style="font-family:' + escapeAttr(c.headingFont) + '; font-size:22px; color:' + escapeAttr(c.textColor) + ';">' + escapeHtml(c.headline || "") + '</h2>' +
    '<p class="pv-sub" style="color:' + escapeAttr(c.mutedTextColor) + ';">' + escapeHtml(c.subheadline || "") + '</p>' +
    '<div style="display:flex; flex-direction:column; gap:8px; margin-bottom:14px;">' +
    '<input class="pv-input" placeholder="Your name" disabled>' +
    '<input class="pv-input" placeholder="Email" disabled>' +
    '</div>' +
    '<button class="pv-cta" style="background:' + escapeAttr(c.brandColor) + '; color:' + escapeAttr(c.buttonTextColor || "#ffffff") + ';">' + escapeHtml(c.getStartedLabel || "Get started") + '</button>' +
    (showText ? '<a class="pv-toggle" style="color:' + escapeAttr(c.mutedTextColor) + ';">' + escapeHtml(c.typeInsteadLabel || "Prefer to type instead?") + '</a>' : '');
}

function renderQuestionsPreview(c) {
  const el = document.getElementById("previewQuestions");
  if (!el) return;
  el.style.background = c.backgroundColor;
  const qs = (c.questions || []).map((q, i) =>
    '<div class="pv-q">' +
    '<div class="pv-q-text">Q' + (i + 1) + '. ' + escapeHtml(q.text || "") + '</div>' +
    (q.helper ? '<div class="pv-q-helper">' + escapeHtml(q.helper) + '</div>' : '') +
    '</div>'
  ).join("");
  el.innerHTML = '<p style="font-size:12px; color:' + escapeAttr(c.mutedTextColor) + '; margin:0 0 8px;">Questions appear one at a time during recording. Here\\'s the full set:</p>' + (qs || '<em style="color:#999;">No questions yet</em>');
}

function renderThankYouPreview(c) {
  const el = document.getElementById("previewThankYou");
  if (!el) return;
  el.style.background = c.backgroundColor;
  el.style.color = c.textColor;
  const logo = c.logoUrl ? '<img class="pv-logo" src="' + escapeAttr(c.logoUrl) + '">' : '';
  const checkBg = "color-mix(in srgb, " + (c.brandColor || "#c9a961") + " 14%, white)";
  const checkColor = c.brandColorDark || c.brandColor || "#a88840";
  const button = (c.thankYouButtonLabel && c.thankYouButtonUrl)
    ? '<button class="pv-cta" style="background:' + escapeAttr(c.brandColor) + '; margin-top:14px;">' + escapeHtml(c.thankYouButtonLabel) + '</button>'
    : '';
  const signature = c.signature
    ? '<p style="font-size:13px; color:' + escapeAttr(c.mutedTextColor) + '; margin-top:18px;">' + escapeHtml(c.signature) + '</p>'
    : '';
  el.innerHTML = '<div style="text-align:center;">' +
    logo +
    '<div class="pv-checkmark" style="background:' + checkBg + '; color:' + escapeAttr(checkColor) + ';">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><polyline points="20 6 9 17 4 12"></polyline></svg>' +
    '</div>' +
    '<h2 class="pv-headline" style="font-family:' + escapeAttr(c.headingFont) + '; font-size:24px;">' + escapeHtml(c.thankYouHeader || "") + '</h2>' +
    '<p style="color:' + escapeAttr(c.mutedTextColor) + '; font-size:14px; margin:0 0 4px;">' + escapeHtml(c.thankYouBody || "") + '</p>' +
    button +
    signature +
    '</div>';
}

function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function escapeAttr(s) { return escapeHtml(s); }

document.getElementById("pw").addEventListener("keydown", e => { if (e.key === "Enter") login(); });
document.getElementById("clientName").addEventListener("change", () => {
  handleClientChange();
  if (currentTab === "submissions") loadSubmissions();
});
document.getElementById("courseName").addEventListener("change", handleFunnelChange);

let currentTab = "branding";
let allSubmissions = [];

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  if (name === "submissions") loadSubmissions();
}

function switchSubTab(name) {
  document.querySelectorAll(".sub-tab").forEach(t => t.classList.toggle("active", t.dataset.subtab === name));
  document.querySelectorAll(".sub-panel").forEach(p => p.classList.toggle("active", p.dataset.sub === name));
  // Scroll to top so customer immediately sees the section + its preview
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openPreview() {
  const clientRaw = document.getElementById("clientName").value;
  const courseRaw = document.getElementById("courseName").value;
  const client = clientRaw && clientRaw !== NEW_OPTION ? clientRaw : "";
  const course = courseRaw && courseRaw !== NEW_OPTION ? courseRaw : "preview";
  if (!client) { toast("Pick a client first."); return; }
  // Stash current (unsaved) form state in localStorage so the recorder can read it
  const config = readForm();
  try {
    localStorage.setItem("vt_preview_" + client + "_" + course, JSON.stringify(config));
  } catch {}
  const url = "/r/" + encodeURIComponent(client) + "/" + encodeURIComponent(course) + "?preview=1";
  window.open(url, "_blank");
}

let featuredKeysByClient = {};

async function loadSubmissions() {
  const pw = localStorage.getItem(STORAGE_KEY);
  if (!pw) { showGate(); return; }
  const grid = document.getElementById("submissionsGrid");
  grid.innerHTML = '<div class="sub-empty">Loading…</div>';
  try {
    const res = await fetch("/admin/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw })
    });
    if (!res.ok) throw new Error("Request failed: " + res.status);
    const { items } = await res.json();
    allSubmissions = items || [];
    // Pre-fetch featured lists for each client present in the list
    const clients = [...new Set(allSubmissions.map(i => i.client).filter(Boolean))];
    featuredKeysByClient = {};
    await Promise.all(clients.map(async c => {
      try {
        const r = await fetch("/featured?client=" + encodeURIComponent(c));
        if (r.ok) {
          const { items } = await r.json();
          featuredKeysByClient[c] = new Set((items || []).map(it => it.key));
        }
      } catch {}
    }));
    renderSubmissions();
  } catch (err) {
    grid.innerHTML = '<div class="sub-empty">Error: ' + escapeHtml(err.message) + '</div>';
  }
}

async function toggleFeature(client, key, makeFeatured) {
  const pw = localStorage.getItem(STORAGE_KEY);
  if (!pw) return;
  try {
    const res = await fetch("/admin/feature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw, client, key, featured: makeFeatured })
    });
    if (!res.ok) throw new Error("Toggle failed: " + res.status);
    if (!featuredKeysByClient[client]) featuredKeysByClient[client] = new Set();
    if (makeFeatured) featuredKeysByClient[client].add(key);
    else featuredKeysByClient[client].delete(key);
    renderSubmissions();
    toast(makeFeatured ? "Featured on intro screen" : "Removed from featured list");
  } catch (err) {
    toast("Error: " + err.message);
  }
}

function renderSubmissions() {
  const clientFilter = document.getElementById("clientName").value;
  const courseFilter = document.getElementById("subsCourseFilter").value;

  let items = allSubmissions;
  if (clientFilter && clientFilter !== NEW_OPTION) items = items.filter(i => i.client === clientFilter);
  if (courseFilter) items = items.filter(i => i.course === courseFilter);

  // Update course filter options based on the currently visible (client-filtered) set
  const courseFilterEl = document.getElementById("subsCourseFilter");
  const previousCourse = courseFilterEl.value;
  const visibleForCourseDropdown = clientFilter && clientFilter !== NEW_OPTION
    ? allSubmissions.filter(i => i.client === clientFilter)
    : allSubmissions;
  const courses = [...new Set(visibleForCourseDropdown.map(i => i.course))].sort();
  courseFilterEl.innerHTML = '<option value="">All funnels</option>' +
    courses.map(c => '<option value="' + escapeAttr(c) + '"' + (c === previousCourse ? ' selected' : '') + '>' + escapeHtml(c) + '</option>').join("");
  if (!courses.includes(previousCourse)) courseFilterEl.value = "";

  document.getElementById("subsCount").textContent = items.length + " submission" + (items.length === 1 ? "" : "s");

  const grid = document.getElementById("submissionsGrid");
  if (items.length === 0) {
    grid.innerHTML = '<div class="sub-empty">No submissions yet for this view.</div>';
    return;
  }
  grid.innerHTML = items.map(item => {
    const date = new Date(item.submittedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const isFeatured = item.client && featuredKeysByClient[item.client] && featuredKeysByClient[item.client].has(item.key);
    const featureToggle = item.type === "video"
      ? '<button data-feature-key="' + escapeAttr(item.key) + '" data-feature-client="' + escapeAttr(item.client || "") + '" data-feature-state="' + (isFeatured ? "1" : "0") + '" class="secondary" style="padding:4px 10px;font-size:12px;margin-top:6px;' + (isFeatured ? 'background:#fef3c7;border-color:#f59e0b;color:#78350f;' : '') + '">' + (isFeatured ? "★ Featured on intro" : "☆ Feature on intro") + '</button>'
      : '';
    const meta = '<div class="sub-meta">' +
      '<div class="name">' + escapeHtml(item.name) + (item.type === "text" ? ' <span class="sub-badge text">text</span>' : '') + '</div>' +
      (item.email ? '<div class="email">' + escapeHtml(item.email) + '</div>' : '') +
      '<div class="date">' + escapeHtml(date) + ' · ' + escapeHtml(item.client || "general") + ' / ' + escapeHtml(item.course) + '</div>' +
      featureToggle +
      '</div>';

    if (item.type === "video") {
      return '<div class="sub-card">' +
        '<video controls preload="metadata" src="' + escapeAttr(item.videoUrl) + '"></video>' +
        meta +
        '</div>';
    } else {
      const answers = (item.responses || []).map(r =>
        '<div class="answer">' +
        '<div class="answer-q">' + escapeHtml(r.question) + '</div>' +
        '<div>' + escapeHtml(r.answer) + '</div>' +
        '</div>'
      ).join("");
      return '<div class="sub-card">' +
        '<div class="sub-text">' + answers + '</div>' +
        meta +
        '</div>';
    }
  }).join("");

  document.querySelectorAll("[data-feature-key]").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-feature-key");
      const client = btn.getAttribute("data-feature-client");
      const state = btn.getAttribute("data-feature-state") === "1";
      toggleFeature(client, key, !state);
    });
  });
}

document.getElementById("subsCourseFilter").addEventListener("change", renderSubmissions);

document.getElementById("logoFileInput").addEventListener("change", e => {
  const f = e.target.files && e.target.files[0];
  if (f) uploadLogo(f);
});

async function exportCsv() {
  const pw = localStorage.getItem(STORAGE_KEY);
  if (!pw) return;
  try {
    const res = await fetch("/admin/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw })
    });
    if (!res.ok) throw new Error("Export failed: " + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "testimonials-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast("Export failed: " + err.message);
  }
}

if (localStorage.getItem(STORAGE_KEY)) {
  loadConfig();
} else {
  showGate();
}
</script>
</body>
</html>`;

// --------------------------------------------------------------
// First-run setup wizard (served at /setup)
// --------------------------------------------------------------
const SETUP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StokeReel · First-time setup</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231a1a1a'/%3E%3Cpolygon points='24,16 24,48 52,32' fill='%23c9a961'/%3E%3C/svg%3E">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #faf7f2; color: #1a1a1a; margin: 0; padding: 24px; line-height: 1.55;
  }
  .card {
    max-width: 560px; margin: 40px auto; padding: 36px 32px; background: white;
    border: 1px solid #e5e0d6; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 12px 36px -8px rgba(0,0,0,0.08);
  }
  h1 { font-family: Georgia, serif; font-weight: 400; margin: 0 0 8px; font-size: 28px; }
  .sub { color: #6b6b6b; margin: 0 0 28px; }
  .step { margin-bottom: 22px; padding-bottom: 22px; border-bottom: 1px solid #f0ebe0; }
  .step:last-child { border-bottom: none; }
  .step-num {
    display: inline-flex; width: 24px; height: 24px; border-radius: 50%;
    background: #c9a961; color: white; font-size: 13px; font-weight: 600;
    align-items: center; justify-content: center; margin-right: 8px; vertical-align: middle;
  }
  .step h2 { display: inline; font-size: 16px; font-weight: 600; vertical-align: middle; margin: 0; }
  .step .help { color: #6b6b6b; font-size: 13px; margin: 6px 0 12px 32px; }
  .step .help a { color: #c9a961; text-decoration: underline; }
  label { display: block; font-size: 13px; margin-bottom: 4px; color: #1a1a1a; font-weight: 500; }
  input { width: 100%; padding: 10px 12px; border: 1px solid #e5e0d6; border-radius: 6px; font-size: 15px; font-family: inherit; }
  input:focus { outline: none; border-color: #c9a961; }
  button {
    background: #c9a961; color: white; border: none; padding: 12px 24px; border-radius: 999px;
    font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 12px; font-family: inherit;
  }
  button:hover:not(:disabled) { background: #a88840; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .field { margin-bottom: 12px; }
  .field-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .error { color: #b84a3a; padding: 12px; background: #fdf0ed; border-radius: 6px; margin-top: 14px; font-size: 14px; }
  .ok { color: #2a7a2a; padding: 12px; background: #eef4ee; border-radius: 6px; margin-top: 14px; font-size: 14px; }
  code { background: #faf7f2; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
</style>
</head>
<body>

<div class="card" id="loadingCard">
  <p>Checking setup…</p>
</div>

<div class="card" id="alreadyCard" style="display:none;">
  <h1>Already set up</h1>
  <p class="sub">This installation is already configured. To change credentials, enter the current admin password.</p>
  <a href="/config">Go to dashboard</a>
</div>

<div class="card" id="setupCard" style="display:none;">
  <div style="display:flex; align-items:center; gap:10px; margin-bottom: 18px;">
    <svg width="36" height="36" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#1a1a1a"/>
      <polygon points="24,16 24,48 52,32" fill="#c9a961"/>
    </svg>
    <strong style="font-family: Georgia, serif; font-size: 20px;">StokeReel</strong>
  </div>
  <h1>Welcome — let's set this up</h1>
  <p class="sub">5 minutes to set up. You'll need a free Cloudflare account and one R2 API token.</p>

  <div class="step">
    <span class="step-num">1</span>
    <h2>Pick an admin password</h2>
    <div class="help">You'll use this to sign into the dashboard at /config.</div>
    <div class="field">
      <input type="password" id="adminPassword" placeholder="Choose a strong password" autocomplete="new-password">
    </div>
  </div>

  <div class="step">
    <span class="step-num">2</span>
    <h2>Cloudflare Account ID</h2>
    <div class="help">Find it at <a href="https://dash.cloudflare.com/?to=/:account/r2/overview" target="_blank">Cloudflare → R2 Overview</a> (right sidebar). 32 hex characters.</div>
    <div class="field">
      <input type="text" id="r2AccountId" placeholder="e.g. 5610219d3ac299838799978c0c62bd94" autocomplete="off">
    </div>
  </div>

  <div class="step">
    <span class="step-num">3</span>
    <h2>R2 bucket name</h2>
    <div class="help">Either an existing R2 bucket or one we'll create at <a href="https://dash.cloudflare.com/?to=/:account/r2/new" target="_blank">Cloudflare R2 → Create bucket</a>. Use lowercase, no spaces.</div>
    <div class="field">
      <input type="text" id="r2BucketName" placeholder="testimonials" value="testimonials" autocomplete="off">
    </div>
  </div>

  <div class="step">
    <span class="step-num">4</span>
    <h2>R2 API Token</h2>
    <div class="help">
      Create one at <a href="https://dash.cloudflare.com/?to=/:account/r2/api-tokens" target="_blank">R2 → Manage R2 API Tokens → Create</a>.
      Permission: <code>Object Read & Write</code>. After creating, copy both keys here:
    </div>
    <div class="field">
      <label>Access Key ID</label>
      <input type="text" id="r2AccessKeyId" placeholder="e.g. 9b64b05362ee5e0711fd592d3c617e26" autocomplete="off">
    </div>
    <div class="field">
      <label>Secret Access Key</label>
      <input type="password" id="r2SecretAccessKey" placeholder="64-character secret" autocomplete="off">
    </div>
  </div>

  <button id="saveBtn" onclick="saveSetup()">Complete setup</button>
  <div id="errBox" class="error" style="display:none;"></div>
  <div id="okBox" class="ok" style="display:none;"></div>
</div>

<script>
async function checkStatus() {
  try {
    const res = await fetch("/setup/status");
    const { configured } = await res.json();
    document.getElementById("loadingCard").style.display = "none";
    if (configured) {
      document.getElementById("alreadyCard").style.display = "block";
    } else {
      document.getElementById("setupCard").style.display = "block";
    }
  } catch (err) {
    document.getElementById("loadingCard").innerHTML = '<div class="error">Could not check setup status: ' + err.message + '</div>';
  }
}

async function saveSetup() {
  const adminPassword = document.getElementById("adminPassword").value.trim();
  const r2AccountId = document.getElementById("r2AccountId").value.trim();
  const r2BucketName = document.getElementById("r2BucketName").value.trim();
  const r2AccessKeyId = document.getElementById("r2AccessKeyId").value.trim();
  const r2SecretAccessKey = document.getElementById("r2SecretAccessKey").value.trim();

  const errBox = document.getElementById("errBox");
  const okBox = document.getElementById("okBox");
  errBox.style.display = okBox.style.display = "none";

  if (!adminPassword || adminPassword.length < 6) { return showErr("Pick an admin password (6+ characters)."); }
  if (!/^[a-f0-9]{32}$/i.test(r2AccountId)) { return showErr("Account ID should be 32 hex characters."); }
  if (!r2BucketName) { return showErr("Bucket name is required."); }
  if (!r2AccessKeyId) { return showErr("Access Key ID is required."); }
  if (!r2SecretAccessKey) { return showErr("Secret Access Key is required."); }

  const btn = document.getElementById("saveBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const res = await fetch("/setup/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminPassword, r2AccountId, r2BucketName, r2AccessKeyId, r2SecretAccessKey })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Setup failed");
    okBox.textContent = "Setup complete. Redirecting to dashboard…";
    okBox.style.display = "block";
    setTimeout(() => { window.location.href = "/config"; }, 1200);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Complete setup";
    showErr(err.message);
  }
}

function showErr(msg) {
  const errBox = document.getElementById("errBox");
  errBox.textContent = msg;
  errBox.style.display = "block";
}

checkStatus();
</script>
</body>
</html>`;
