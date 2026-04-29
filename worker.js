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
      // If this request is hitting a registered custom hostname (Cloudflare for SaaS),
      // treat /<funnel-slug> as /r/<mapped-client>/<funnel-slug>. Pretty URLs for customers.
      const customRoute = await resolveCustomHostnameRoute(env, url.hostname, url.pathname);
      if (customRoute && request.method === "GET") {
        return serveHostedRecorder(url.origin, customRoute.client, customRoute.course);
      }

      if ((url.pathname === "/" || url.pathname === "/start") && request.method === "GET") {
        return new Response(LANDING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/welcome" && request.method === "GET") {
        return await handleWelcomeAccess(request, env, url);
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
      if (url.pathname === "/admin/custom-domain/register" && request.method === "POST") {
        return withCors(await handleCustomDomainRegister(request, env));
      }
      if (url.pathname === "/admin/custom-domain/status" && request.method === "POST") {
        return withCors(await handleCustomDomainStatus(request, env));
      }
      if (url.pathname === "/admin/custom-domain/delete" && request.method === "POST") {
        return withCors(await handleCustomDomainDelete(request, env));
      }
      if (url.pathname === "/admin/shortlink/create" && request.method === "POST") {
        return withCors(await handleShortlinkCreate(request, env));
      }
      // /s/<code> — short link → serves the mapped recorder
      const shortMatch = url.pathname.match(/^\/s\/([A-Za-z0-9]{4,12})\/?$/);
      if (shortMatch && request.method === "GET") {
        return await serveShortlink(env, url.origin, shortMatch[1]);
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
// /welcome — gated so only paid customers (or admin with token) can see it
// --------------------------------------------------------------
async function handleWelcomeAccess(request, env, url) {
  const sessionId = url.searchParams.get("session_id");
  const token = url.searchParams.get("token");

  // Render-time substitution: replace placeholders with configured values.
  async function buildHtml(tier) {
    const deployUrl = (await getCred(env, "WELCOME_DEPLOY_URL")) || "#deploy-url-not-configured";
    const tierBlock = tier === "agency"
      ? '<div class="card" style="border:2px solid #c9a961; background: linear-gradient(135deg,#fdfbf6,#f5efe2);">' +
        '<span class="step-num" style="background:#c9a961;">⭐</span>' +
        '<h3>You are on the Agency plan</h3>' +
        '<p>You can run StokeReel for unlimited clients and brands from a single install. Specifically:</p>' +
        '<ul style="font-size: 14px; line-height: 1.7; margin: 8px 0 0; padding-left: 20px;">' +
        '<li><strong>One worker, unlimited clients.</strong> No need to deploy a separate worker per client. Use the dashboard client switcher.</li>' +
        '<li><strong>Each client = its own slug.</strong> Type a new slug (e.g. <code>fretsfordays</code>) in the dashboard. Their recorder URL becomes <code>recorder.com/r/fretsfordays/&lt;funnel&gt;</code>.</li>' +
        '<li><strong>Reseller rights are explicit.</strong> Charge your clients whatever you want for setup. Most agencies charge $500–$2,000 per client.</li>' +
        '<li><strong>The 5-day email sequence below works for every client.</strong> Adapt the bracketed fields per brand.</li>' +
        '<li><strong>60 days of email support</strong> instead of 30.</li>' +
        '</ul></div>'
      : '';
    return WELCOME_HTML
      .split("{{DEPLOY_URL}}").join(deployUrl)
      .split("{{TIER_BLOCK}}").join(tierBlock);
  }

  // Owner backdoor for testing/QA — set WELCOME_TOKEN secret to a long random string
  const welcomeToken = await getCred(env, "WELCOME_TOKEN");
  if (welcomeToken && token && token === welcomeToken) {
    // Allow ?tier=agency in the test URL to preview the agency block
    const testTier = url.searchParams.get("tier") === "agency" ? "agency" : "single";
    return new Response(await buildHtml(testTier), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // Stripe session verification — Stripe redirects with ?session_id={CHECKOUT_SESSION_ID}
  if (sessionId && /^cs_(test_|live_)?[A-Za-z0-9_-]{10,}$/.test(sessionId)) {
    const stripeKey = await getCred(env, "STRIPE_SECRET_KEY");
    if (stripeKey) {
      try {
        const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(sessionId), {
          headers: { "Authorization": "Bearer " + stripeKey }
        });
        if (stripeRes.ok) {
          const session = await stripeRes.json();
          // Accept any session that's been paid (one-time or subscription)
          if (session && (session.payment_status === "paid" || session.payment_status === "no_payment_required")) {
            // Detect tier from amount paid (in cents)
            // 9700 = $97 (single), 29700 = $297 (agency)
            const tier = session.amount_total && session.amount_total >= 19700 ? "agency" : "single";
            return new Response(await buildHtml(tier), {
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "private, no-store",
                "Referrer-Policy": "no-referrer"
              }
            });
          }
        }
      } catch {}
    }
  }

  // Not verified — bounce to landing
  return Response.redirect(url.origin + "/", 302);
}

// --------------------------------------------------------------
// Custom hostnames (Cloudflare for SaaS)
// Lets customers point recorder.theirsite.com -> Michael's worker without
// migrating DNS to Cloudflare. They just add ONE CNAME at their existing DNS.
// --------------------------------------------------------------

function sanitizeHostname(s) {
  if (!s) return "";
  let h = String(s).trim().toLowerCase();
  if (h.indexOf("https://") === 0) h = h.slice(8);
  else if (h.indexOf("http://") === 0) h = h.slice(7);
  while (h.endsWith("/")) h = h.slice(0, -1);
  return h;
}

function isValidHostname(h) {
  if (!h) return false;
  if (h.length < 4 || h.length > 253) return false;
  if (h.indexOf("/") !== -1 || h.indexOf(" ") !== -1) return false;
  if (h.indexOf(".") === -1) return false;
  return /^[a-z0-9.-]+$/.test(h);
}

async function readHostnameMapping(env, hostname) {
  const h = sanitizeHostname(hostname);
  if (!h) return null;
  const r = await env.BUCKET.get("hostnames/" + h + ".json");
  if (!r) return null;
  try { return JSON.parse(await r.text()); } catch { return null; }
}

async function resolveCustomHostnameRoute(env, host, pathname) {
  // Skip our primary worker host so the dashboard / setup / etc keep routing normally
  if (host.endsWith(".workers.dev")) return null;
  const mapping = await readHostnameMapping(env, host);
  if (!mapping || !mapping.client) return null;
  // Don't intercept admin/dashboard paths even on custom hostnames
  if (pathname.startsWith("/config") || pathname.startsWith("/admin") ||
      pathname.startsWith("/setup") || pathname.startsWith("/r/")) return null;
  const slug = pathname.replace(/^\/+|\/+$/g, "");
  const course = slug ? slug.split("/")[0] : (mapping.defaultCourse || "general");
  const safeCourse = sanitizeSlug(course);
  return { client: sanitizeSlug(mapping.client), course: safeCourse };
}

async function handleCustomDomainRegister(request, env) {
  const { password, client, hostname } = await request.json().catch(() => ({}));
  const adminPw = await getCred(env, "ADMIN_PASSWORD");
  if (!adminPw || password !== adminPw) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    });
  }
  const cfToken = await getCred(env, "CF_API_TOKEN");
  const cfZone = await getCred(env, "CF_ZONE_ID");
  const cfFallback = await getCred(env, "CF_FALLBACK_ORIGIN");
  if (!cfToken || !cfZone || !cfFallback) {
    return new Response(JSON.stringify({
      error: "not_configured",
      message: "Custom domains via Cloudflare for SaaS aren't configured on this worker yet. Use the iframe embed in the meantime."
    }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const h = sanitizeHostname(hostname);
  if (!isValidHostname(h)) {
    return new Response(JSON.stringify({ error: "invalid_hostname" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }
  if (!client) {
    return new Response(JSON.stringify({ error: "client_required" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }

  // Register with Cloudflare
  const cfRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${cfZone}/custom_hostnames`, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + cfToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      hostname: h,
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } }
    })
  });
  const cfData = await cfRes.json().catch(() => ({}));
  if (!cfRes.ok || !cfData.success) {
    return new Response(JSON.stringify({
      error: "cloudflare_api_error",
      details: cfData.errors || cfData
    }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  const mapping = {
    hostname: h,
    client: sanitizeSlug(client),
    cf_id: cfData.result.id,
    status: cfData.result.status || "pending",
    ssl_status: cfData.result.ssl?.status || "pending_validation",
    cname_target: cfFallback,
    created_at: new Date().toISOString()
  };
  await env.BUCKET.put("hostnames/" + h + ".json", JSON.stringify(mapping, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });

  return new Response(JSON.stringify({
    ok: true,
    hostname: h,
    cname_target: cfFallback,
    cf_id: cfData.result.id,
    status: mapping.status,
    ssl_status: mapping.ssl_status
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function handleCustomDomainStatus(request, env) {
  const { password, hostname } = await request.json().catch(() => ({}));
  const adminPw = await getCred(env, "ADMIN_PASSWORD");
  if (!adminPw || password !== adminPw) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    });
  }
  const cfToken = await getCred(env, "CF_API_TOKEN");
  const cfZone = await getCred(env, "CF_ZONE_ID");
  if (!cfToken || !cfZone) {
    return new Response(JSON.stringify({ error: "not_configured" }), {
      status: 503, headers: { "Content-Type": "application/json" }
    });
  }
  const h = sanitizeHostname(hostname);
  const mapping = await readHostnameMapping(env, h);
  if (!mapping) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404, headers: { "Content-Type": "application/json" }
    });
  }

  const cfRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${cfZone}/custom_hostnames/${mapping.cf_id}`, {
    headers: { "Authorization": "Bearer " + cfToken }
  });
  const cfData = await cfRes.json().catch(() => ({}));
  if (!cfRes.ok || !cfData.success) {
    return new Response(JSON.stringify({
      hostname: h,
      status: mapping.status,
      ssl_status: mapping.ssl_status,
      cname_target: mapping.cname_target,
      cloudflare_error: true
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  mapping.status = cfData.result.status || mapping.status;
  mapping.ssl_status = cfData.result.ssl?.status || mapping.ssl_status;
  mapping.last_checked = new Date().toISOString();
  await env.BUCKET.put("hostnames/" + h + ".json", JSON.stringify(mapping, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });

  return new Response(JSON.stringify({
    hostname: mapping.hostname,
    client: mapping.client,
    status: mapping.status,
    ssl_status: mapping.ssl_status,
    cname_target: mapping.cname_target,
    last_checked: mapping.last_checked
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function handleCustomDomainDelete(request, env) {
  const { password, hostname } = await request.json().catch(() => ({}));
  const adminPw = await getCred(env, "ADMIN_PASSWORD");
  if (!adminPw || password !== adminPw) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    });
  }
  const cfToken = await getCred(env, "CF_API_TOKEN");
  const cfZone = await getCred(env, "CF_ZONE_ID");
  const h = sanitizeHostname(hostname);
  const mapping = await readHostnameMapping(env, h);
  if (!mapping) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404, headers: { "Content-Type": "application/json" }
    });
  }
  // Best-effort: delete on Cloudflare side too
  if (cfToken && cfZone && mapping.cf_id) {
    await fetch(`https://api.cloudflare.com/client/v4/zones/${cfZone}/custom_hostnames/${mapping.cf_id}`, {
      method: "DELETE",
      headers: { "Authorization": "Bearer " + cfToken }
    }).catch(() => {});
  }
  await env.BUCKET.delete("hostnames/" + h + ".json");
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "Content-Type": "application/json" }
  });
}

// --------------------------------------------------------------
// Short links — /s/<code> redirects to /r/<client>/<funnel>
// Creates compact share URLs like stokereel.workers.dev/s/Ab3xYz
// --------------------------------------------------------------
function generateShortCode(length) {
  // No 0/O, 1/l, etc. for less ambiguity
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rand = crypto.getRandomValues(new Uint8Array(length || 6));
  let code = "";
  for (let i = 0; i < rand.length; i++) code += chars[rand[i] % chars.length];
  return code;
}

async function serveShortlink(env, origin, code) {
  const r = await env.BUCKET.get("shortlinks/" + code + ".json");
  if (!r) return new Response("Short link not found", { status: 404 });
  let data;
  try { data = JSON.parse(await r.text()); } catch { return new Response("Short link corrupted", { status: 500 }); }
  if (!data.client || !data.course) return new Response("Short link malformed", { status: 500 });
  return serveHostedRecorder(origin, data.client, data.course);
}

async function handleShortlinkCreate(request, env) {
  const { password, client, course, preferredHost, force } = await request.json().catch(() => ({}));
  const adminPw = await getCred(env, "ADMIN_PASSWORD");
  if (!adminPw || password !== adminPw) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    });
  }
  const c = sanitizeSlug(client);
  const co = sanitizeSlug(course);
  const brandHost = await getCred(env, "BRAND_HOST");
  if (!c || !co || c === "general" && !client) {
    return new Response(JSON.stringify({ error: "client_and_course_required" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }

  // Pick the host the short URL will live on.
  // 1. Customer's custom domain (per-client) if passed
  // 2. BRAND_HOST env (Michael's branded domain like stokereel.com)
  // 3. Falls back to current request origin (workers.dev) — ugly but functional
  function pickHost() {
    const reqOrigin = new URL(request.url).origin;
    let h = (preferredHost || "").trim();
    if (h.indexOf("https://") === 0) h = h.slice(8);
    else if (h.indexOf("http://") === 0) h = h.slice(7);
    while (h.endsWith("/")) h = h.slice(0, -1);
    if (h && isValidHostname(h)) return "https://" + h;
    if (brandHost) {
      let b = String(brandHost).trim();
      if (b.indexOf("https://") === 0) b = b.slice(8);
      else if (b.indexOf("http://") === 0) b = b.slice(7);
      while (b.endsWith("/")) b = b.slice(0, -1);
      if (b && isValidHostname(b)) return "https://" + b;
    }
    return reqOrigin;
  }

  // Re-use existing short link for this funnel unless caller asked for a fresh one
  const reverseKey = "shortlinks-by-funnel/" + c + "__" + co + ".json";
  if (!force) {
    const existing = await env.BUCKET.get(reverseKey);
    if (existing) {
      try {
        const reverseData = JSON.parse(await existing.text());
        if (reverseData.code) {
          const fullUrl = pickHost() + "/s/" + reverseData.code;
          return new Response(JSON.stringify({ code: reverseData.code, client: c, course: co, full_url: fullUrl, reused: true }), {
            status: 200, headers: { "Content-Type": "application/json" }
          });
        }
      } catch {}
    }
  } else {
    // Force regenerate: invalidate the existing code mapping
    const existing = await env.BUCKET.get(reverseKey);
    if (existing) {
      try {
        const reverseData = JSON.parse(await existing.text());
        if (reverseData.code) {
          await env.BUCKET.delete("shortlinks/" + reverseData.code + ".json");
        }
      } catch {}
    }
  }

  // Generate a new collision-free code
  let code = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    code = generateShortCode(6);
    const taken = await env.BUCKET.get("shortlinks/" + code + ".json");
    if (!taken) break;
    code = "";
  }
  if (!code) {
    return new Response(JSON.stringify({ error: "could_not_generate" }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  const payload = { client: c, course: co, created_at: new Date().toISOString() };
  await env.BUCKET.put("shortlinks/" + code + ".json", JSON.stringify(payload, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });
  await env.BUCKET.put(reverseKey, JSON.stringify({ code }, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });

  const fullUrl = pickHost() + "/s/" + code;
  return new Response(JSON.stringify({ code, client: c, course: co, full_url: fullUrl, reused: false }), {
    status: 200, headers: { "Content-Type": "application/json" }
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
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
    background:
      radial-gradient(1200px 800px at 100% -10%, rgba(201, 169, 97, 0.08), transparent 60%),
      radial-gradient(900px 600px at -10% 100%, rgba(26, 26, 26, 0.04), transparent 60%),
      #faf7f2;
    color: #1a1a1a;
    margin: 0;
    padding: 24px;
    line-height: 1.5;
    font-feature-settings: "ss01" on, "cv11" on;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  h1 { font-family: Georgia, serif; font-weight: 400; margin: 0 0 8px; letter-spacing: -0.015em; }
  .sub { color: #6b6b6b; margin: 0 0 24px; font-size: 14px; }
  /* Premium polish */
  input, select, textarea, button { font-family: inherit; -webkit-font-smoothing: antialiased; }
  input[type="text"], input[type="number"], input[type="email"], input[type="password"], textarea, select {
    transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
  }
  input[type="text"]:focus, input[type="number"]:focus, input[type="email"]:focus, input[type="password"]:focus, textarea:focus, select:focus {
    outline: none;
    border-color: #c9a961 !important;
    box-shadow: 0 0 0 3px rgba(201, 169, 97, 0.18);
  }
  /* Buttons get a lift */
  button:not(.tab):not(.sub-tab):not(.copy-btn) {
    transition: transform 0.12s ease, box-shadow 0.15s ease, background 0.15s ease;
  }
  button:not(.tab):not(.sub-tab):not(.copy-btn):not(:disabled):not(.secondary):hover {
    transform: translateY(-1px);
  }
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
  .panel {
    background: white;
    border: 1px solid #e5e0d6;
    border-radius: 14px;
    padding: 32px;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 28px -12px rgba(15, 23, 42, 0.08);
  }
  .section {
    margin-bottom: 32px;
    padding-bottom: 32px;
    border-bottom: 1px solid #f0ebe0;
  }
  .section:last-child { border-bottom: none; padding-bottom: 0; margin-bottom: 0; }
  .section h2 {
    font-size: 17px; font-weight: 700; margin: 0 0 14px;
    letter-spacing: -0.005em;
    color: #1a1a1a;
    display: flex; align-items: center; gap: 8px;
  }
  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 13px; color: #1a1a1a; margin-bottom: 6px; font-weight: 500; }
  .field input, .field textarea, .field select {
    width: 100%; padding: 11px 14px; border: 1px solid #e5e0d6; border-radius: 8px;
    font-size: 14px; font-family: inherit; background: white; color: #1a1a1a;
  }
  .field textarea { resize: vertical; min-height: 72px; line-height: 1.55; }
  .field-row { display: grid; grid-template-columns: 80px 1fr; gap: 12px; align-items: center; }
  .field-row input[type=color] {
    width: 80px; height: 42px; padding: 2px;
    border: 1px solid #e5e0d6; border-radius: 8px;
    cursor: pointer; background: white;
  }
  .gate { max-width: 380px; margin: 80px auto; text-align: center; padding: 32px;
    background: white; border: 1px solid #e5e0d6; border-radius: 14px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 12px 36px -12px rgba(0,0,0,0.12);
  }
  .gate input {
    width: 100%; padding: 13px 14px; border: 1px solid #e5e0d6;
    border-radius: 8px; font-size: 15px; margin: 16px 0;
  }
  button {
    background: linear-gradient(180deg, #c9a961 0%, #b89752 100%);
    color: white; border: none; padding: 11px 22px; border-radius: 999px;
    cursor: pointer; font-size: 14px; font-weight: 600; font-family: inherit;
    letter-spacing: 0.005em;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.2),
      0 1px 2px rgba(15,23,42,0.06),
      0 4px 14px -4px rgba(201,169,97,0.4);
  }
  button:hover:not(:disabled):not(.secondary) {
    background: linear-gradient(180deg, #c9a961 0%, #a88840 100%);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.2),
      0 2px 4px rgba(15,23,42,0.08),
      0 8px 22px -4px rgba(201,169,97,0.5);
  }
  button:active:not(:disabled) { transform: translateY(0); }
  button:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
  button.secondary {
    background: white; color: #1a1a1a; border: 1px solid #e5e0d6;
    box-shadow: 0 1px 2px rgba(15,23,42,0.04);
  }
  button.secondary:hover:not(:disabled) {
    background: #faf7f2;
    border-color: #d8d2c2;
    box-shadow: 0 2px 6px rgba(15,23,42,0.06);
  }
  .top-bar {
    display: flex; justify-content: space-between; align-items: flex-start;
    flex-wrap: wrap; gap: 16px; margin-bottom: 24px;
    max-width: 1240px; margin-left: auto; margin-right: auto;
    padding: 20px 24px;
    background: white;
    border: 1px solid #e5e0d6;
    border-radius: 14px;
    box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 6px 20px -8px rgba(15,23,42,0.06);
  }
  .top-bar h1 { font-size: 22px; }
  .top-bar h1 svg { vertical-align: middle; }
  .top-bar .sub { margin: 0; font-size: 13px; color: #6b6b6b; }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .controls select {
    padding: 9px 12px !important;
    border: 1px solid #e5e0d6 !important;
    border-radius: 8px !important;
    background: #faf7f2 !important;
    font-size: 13px !important;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .controls select:hover { background: white !important; border-color: #d8d2c2 !important; }
  .preview {
    position: sticky; top: 24px;
    border: 1px solid #e5e0d6; border-radius: 6px; overflow: hidden;
    height: 600px; background: white;
  }
  .preview iframe { width: 100%; height: 100%; border: 0; }
  .preview-label { padding: 8px 12px; background: #f5f0e6; border-bottom: 1px solid #e5e0d6; font-size: 12px; color: #6b6b6b; text-transform: uppercase; letter-spacing: 0.5px; }
  .toast {
    position: fixed; bottom: 28px; right: 28px;
    background: linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 100%);
    color: white; padding: 14px 22px; border-radius: 12px;
    font-size: 14px; font-weight: 500;
    opacity: 0; transform: translateY(8px);
    transition: opacity 0.25s ease, transform 0.25s ease;
    pointer-events: none;
    box-shadow: 0 4px 14px rgba(0,0,0,0.18), 0 12px 32px -8px rgba(0,0,0,0.25);
    border: 1px solid rgba(255,255,255,0.08);
    z-index: 9999;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .question-block { background: #faf7f2; padding: 12px; border-radius: 4px; margin-bottom: 10px; }
  .question-block label { font-size: 12px; }
  .error { color: #b84a3a; padding: 12px; background: #fdf0ed; border-radius: 4px; }
  .help-text { font-size: 12px; color: #6b6b6b; margin-top: 4px; }
  .tabs {
    display: flex; gap: 4px;
    margin: 0 auto 24px;
    max-width: 1240px;
    padding: 6px;
    background: white;
    border: 1px solid #e5e0d6;
    border-radius: 12px;
    width: fit-content;
    box-shadow: 0 1px 2px rgba(15,23,42,0.04);
  }
  .tab {
    background: transparent; border: none; padding: 9px 22px; cursor: pointer;
    font-size: 14px; font-weight: 600; color: #6b6b6b; font-family: inherit;
    border-radius: 8px;
    transition: background 0.18s, color 0.18s;
    box-shadow: none;
  }
  .tab:hover { color: #1a1a1a; background: #faf7f2; transform: none; box-shadow: none; }
  .tab.active {
    color: white;
    background: linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 100%);
    box-shadow: 0 1px 2px rgba(0,0,0,0.1), 0 2px 8px -2px rgba(0,0,0,0.15);
  }
  .tab.active:hover { color: white; background: linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 100%); }
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
    margin-top: 36px; padding-top: 24px; border-top: 1px solid #f0ebe0;
  }
  .sub-panel-actions .hint {
    font-size: 12px; color: #9a9385; margin-left: auto;
  }
  /* Sub-tab icons */
  .sub-tab {
    display: inline-flex !important;
    align-items: center;
    gap: 7px !important;
  }
  .sub-tab svg { flex-shrink: 0; }
  /* Premium share cards */
  .share-card {
    background: white;
    border: 1px solid #e5e0d6;
    border-radius: 12px;
    padding: 20px 22px;
    margin-bottom: 14px;
    transition: border-color 0.18s, box-shadow 0.18s;
  }
  .share-card:hover {
    border-color: #d8d2c2;
    box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 6px 18px -8px rgba(15,23,42,0.08);
  }
  .share-card-head {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 8px; flex-wrap: wrap;
  }
  .share-card-head strong {
    font-size: 15px; color: #1a1a1a; font-weight: 600;
  }
  .share-badge {
    background: linear-gradient(180deg, #c9a961, #b89752);
    color: white;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 3px 9px;
    border-radius: 999px;
    box-shadow: 0 1px 2px rgba(201,169,97,0.3);
  }
  .share-tag {
    font-size: 11px;
    color: #9a9385;
    font-weight: 500;
  }
  .share-desc {
    font-size: 13px;
    color: #6b6b6b;
    margin: 0 0 12px;
    line-height: 1.55;
  }
  .share-input-row {
    display: flex; gap: 6px; align-items: stretch;
  }
  .share-input-row input {
    flex: 1;
    padding: 10px 14px !important;
    border: 1px solid #e5e0d6 !important;
    border-radius: 8px !important;
    font-family: ui-monospace, "SF Mono", monospace !important;
    font-size: 12px !important;
    background: #faf7f2 !important;
    color: #1a1a1a;
  }
  .share-input-row input:focus {
    background: white !important;
    border-color: #c9a961 !important;
  }
  /* Wizard nav at bottom of each step */
  .wizard-nav {
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    margin-top: 36px; padding-top: 24px; border-top: 1px solid #f0ebe0;
  }
  .wizard-nav button.next {
    background: linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 100%);
    color: white;
    padding: 12px 20px;
    font-size: 14px;
    font-weight: 600;
    margin-left: auto;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.1),
      0 1px 2px rgba(0,0,0,0.1),
      0 6px 16px -4px rgba(0,0,0,0.2);
  }
  .wizard-nav button.next:hover:not(:disabled) {
    background: linear-gradient(180deg, #2a2a2a 0%, #1a1a1a 100%);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.12),
      0 2px 4px rgba(0,0,0,0.12),
      0 12px 24px -4px rgba(0,0,0,0.25);
  }
  .wizard-nav button.prev {
    background: white;
    color: #6b6b6b;
    border: 1px solid #e5e0d6;
    padding: 11px 18px;
    font-size: 13px;
    font-weight: 500;
  }
  .wizard-nav button.prev:hover:not(:disabled) {
    background: #faf7f2;
    color: #1a1a1a;
  }
  .wizard-nav .step-meta {
    font-size: 12px;
    color: #9a9385;
    font-weight: 500;
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


  <div class="sub-tabs">
    <button class="sub-tab active" data-subtab="style" onclick="switchSubTab('style')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>
      Style
    </button>
    <button class="sub-tab" data-subtab="welcome" onclick="switchSubTab('welcome')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
      Welcome message
    </button>
    <button class="sub-tab" data-subtab="questions" onclick="switchSubTab('questions')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      Questions
    </button>
    <button class="sub-tab" data-subtab="thankyou" onclick="switchSubTab('thankyou')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      Thank-you message
    </button>
    <button class="sub-tab" data-subtab="buttons" onclick="switchSubTab('buttons')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><rect x="2" y="9" width="20" height="6" rx="3"/><circle cx="8" cy="12" r="1.5" fill="currentColor"/></svg>
      Buttons
    </button>
    <button class="sub-tab" data-subtab="settings" onclick="switchSubTab('settings')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </button>
    <button class="sub-tab" data-subtab="share" onclick="switchSubTab('share')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
      Share
    </button>
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

      <div class="wizard-nav"></div>
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
      <div class="wizard-nav"></div>
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
      <div class="wizard-nav"></div>
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
      <div class="wizard-nav"></div>
      </div><!-- /sub-panel buttons -->

      <div class="sub-panel" data-sub="questions">
      <p class="sub-panel-hint">These appear one at a time during recording. URL slug determines which folder submissions land in.</p>
      <div class="section">
        <h2>Questions</h2>
        <div id="questionsContainer"></div>
        <div class="preview-block" id="previewQuestions"></div>
      </div>
      <div class="wizard-nav"></div>
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
        <p class="help-text" style="margin: 0 0 12px;">Most people don't need this. The <strong>iframe embed</strong> on the Branding tab already shows your own domain naturally — paste into any page on your site, no DNS work needed.</p>
        <p class="help-text" style="margin: 0 0 14px;">Only set this up if you want the <em>standalone shareable link</em> on your domain. Works with any DNS provider (GoDaddy, Namecheap, your existing setup) — keep your DNS where it is and just add ONE CNAME record.</p>

        <div id="customDomainCard" style="background:white; border:1px solid #e5e0d6; border-radius:8px; padding:16px;">
          <!-- Populated by JS based on current registration state -->
          <p style="color:#6b6b6b; font-size:13px; margin:0;">Loading…</p>
        </div>

        <input type="hidden" data-key="customDomain">
      </div>

      <div class="wizard-nav"></div>
      </div><!-- /sub-panel settings -->

      <div class="sub-panel" data-sub="share">
      <p class="sub-panel-hint">All set — here are the three ways to put StokeReel in front of your customers. Pick the one that fits your funnel.</p>

      <div class="section">
        <h2>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          Share &amp; embed this funnel
        </h2>
        <p class="help-text" id="shareLabel" style="margin: 0 0 16px;"></p>

        <div class="share-option" id="shareBox" style="display:none;">
          <div class="share-card">
            <div class="share-card-head">
              <span class="share-badge">Recommended</span>
              <strong>Iframe embed</strong>
            </div>
            <p class="share-desc">Copy this snippet and paste it into a page on your website. The recorder will appear on your page like it was always part of it. Works with every website builder — your visitors stay on your site and never see ours.</p>
            <div class="share-input-row">
              <input id="shareIframe" type="text" readonly>
              <button onclick="copyShare('shareIframe', this)" class="secondary">Copy</button>
            </div>
          </div>

          <div class="share-card">
            <div class="share-card-head">
              <strong>Direct shareable URL</strong>
            </div>
            <p class="share-desc">Send via email, SMS, DM, or any text-based channel. Auto-uses your custom domain if one is set.</p>
            <div class="share-input-row">
              <input id="shareUrl" type="text" readonly>
              <button onclick="copyShare('shareUrl', this)" class="secondary">Copy</button>
            </div>
          </div>

          <div class="share-card">
            <div class="share-card-head">
              <strong>Short link</strong>
              <span class="share-tag">Persistent — same code every time</span>
            </div>
            <p class="share-desc">Tiny URL that redirects to this funnel. Best for printed materials, SMS, or anywhere character count matters.</p>
            <div class="share-input-row">
              <input id="shareShort" type="text" readonly placeholder="Loading…">
              <button onclick="copyShare('shareShort', this)" class="secondary">Copy</button>
              <button onclick="regenerateShortLink()" id="shortLinkBtn" class="secondary" title="Generate a new short code (invalidates the old one)" style="padding: 9px 12px;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="wizard-nav"></div>
      </div><!-- /sub-panel share -->

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

async function renderCustomDomainCard() {
  const card = document.getElementById("customDomainCard");
  if (!card) return;
  const customDomain = (currentConfig && currentConfig.customDomain || "").trim();
  if (!customDomain) {
    card.innerHTML =
      '<label style="display:block; font-size:13px; color:#1a1a1a; font-weight:600; margin-bottom:6px;">Add a custom domain</label>' +
      '<p style="font-size:12px; color:#6b6b6b; margin:0 0 8px;">e.g. <code>recorder.yourdomain.com</code></p>' +
      '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
      '<input type="text" id="customDomainInput" placeholder="recorder.yourdomain.com" style="flex:1; min-width:240px; padding:9px 12px; border:1px solid #e5e0d6; border-radius:6px; font-size:14px;">' +
      '<button onclick="registerCustomDomain()">Register domain</button>' +
      '</div>' +
      '<p style="font-size:12px; color:#6b6b6b; margin:10px 0 0;">After clicking Register, you\\u2019ll get a CNAME record to add at your DNS provider. Cloudflare auto-issues SSL once you add it.</p>';
    return;
  }
  // Already have a custom domain set — show its status
  card.innerHTML = '<p style="color:#6b6b6b; font-size:13px; margin:0;">Checking status of <strong>' + escapeHtml(customDomain) + '</strong>…</p>';
  await refreshCustomDomainStatus(customDomain);
}

async function registerCustomDomain() {
  const input = document.getElementById("customDomainInput");
  const hostname = (input && input.value || "").trim();
  if (!hostname) { toast("Enter a domain first."); return; }
  const pw = localStorage.getItem(STORAGE_KEY);
  const clientRaw = document.getElementById("clientName").value;
  const client = clientRaw && clientRaw !== NEW_OPTION ? clientRaw : "";
  if (!client) { toast("Pick a client first."); return; }
  const card = document.getElementById("customDomainCard");
  card.innerHTML = '<p style="color:#6b6b6b; font-size:13px; margin:0;">Registering…</p>';
  try {
    const res = await fetch("/admin/custom-domain/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw, client, hostname })
    });
    const data = await res.json();
    if (res.status === 503) {
      card.innerHTML =
        '<div style="padding:14px; background:#fdf0ed; border:1px solid #b84a3a; border-radius:6px; font-size:13px; color:#1a1a1a; line-height:1.6;">' +
        '<strong>Custom domains aren\\u2019t enabled on this worker yet.</strong>' +
        '<p style="margin:6px 0 0;">The owner needs to set up Cloudflare for SaaS one time before this feature works. In the meantime, use the <strong>iframe embed</strong> on the Branding tab \\u2014 it gives you the same outcome (your domain in the URL bar) with zero DNS setup.</p>' +
        '</div>';
      return;
    }
    if (!res.ok) throw new Error(data.error || ("Register failed: " + res.status));
    if (currentConfig) currentConfig.customDomain = data.hostname;
    const hiddenInput = document.querySelector('input[type="hidden"][data-key="customDomain"]');
    if (hiddenInput) hiddenInput.value = data.hostname;
    await save();
    await refreshCustomDomainStatus(data.hostname);
  } catch (err) {
    card.innerHTML =
      '<div style="padding:12px; background:#fdf0ed; color:#b84a3a; border-radius:6px; font-size:13px;">Error: ' + escapeHtml(err.message) + '</div>' +
      '<button onclick="renderCustomDomainCard()" class="secondary" style="margin-top:10px;">Try again</button>';
  }
}

async function refreshCustomDomainStatus(hostname) {
  const pw = localStorage.getItem(STORAGE_KEY);
  const card = document.getElementById("customDomainCard");
  try {
    const res = await fetch("/admin/custom-domain/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw, hostname })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ("Status check failed: " + res.status));

    const ok = data.status === "active" && data.ssl_status === "active";
    const cnameInstructions =
      '<div style="margin-top:12px; padding:14px; background:#fdfbf6; border:1px solid #c9a961; border-radius:6px; line-height:1.6; font-size:13px;">' +
      '<strong>Add this CNAME record at your DNS provider</strong> (GoDaddy, Namecheap, wherever your domain lives):' +
      '<table style="width:100%; margin-top:8px; font-family:monospace; font-size:12px; border-collapse:collapse;">' +
      '<tr><td style="padding:4px 6px; color:#6b6b6b;">Type</td><td style="padding:4px 6px;">CNAME</td></tr>' +
      '<tr><td style="padding:4px 6px; color:#6b6b6b;">Name / Host</td><td style="padding:4px 6px;">' + escapeHtml(hostname.split(".")[0]) + '</td></tr>' +
      '<tr><td style="padding:4px 6px; color:#6b6b6b;">Target / Value</td><td style="padding:4px 6px;">' + escapeHtml(data.cname_target || "") + '</td></tr>' +
      '<tr><td style="padding:4px 6px; color:#6b6b6b;">TTL</td><td style="padding:4px 6px;">Auto / 300</td></tr>' +
      '</table>' +
      '<p style="margin:10px 0 0; color:#6b6b6b; font-size:12px;">Once added, Cloudflare auto-issues SSL within ~5 minutes. Click <em>Refresh status</em> below to check.</p>' +
      '</div>';

    const statusBadge = ok
      ? '<span style="display:inline-block; padding:3px 10px; border-radius:999px; background:#dcfce7; color:#166534; font-size:11px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;">\\u2713 Active</span>'
      : '<span style="display:inline-block; padding:3px 10px; border-radius:999px; background:#fef3c7; color:#78350f; font-size:11px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;">\\u23F3 Pending</span>';

    card.innerHTML =
      '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">' +
      '<strong style="font-family:monospace; font-size:14px;">' + escapeHtml(hostname) + '</strong>' +
      statusBadge +
      '<div style="margin-left:auto; display:flex; gap:6px;">' +
      '<button class="secondary" onclick="refreshCustomDomainStatus(\\'' + escapeAttr(hostname) + '\\')" style="padding:6px 12px; font-size:12px;">Refresh status</button>' +
      '<button class="secondary" onclick="deleteCustomDomain(\\'' + escapeAttr(hostname) + '\\')" style="padding:6px 12px; font-size:12px; color:#b84a3a; border-color:#b84a3a;">Remove</button>' +
      '</div>' +
      '</div>' +
      '<p style="margin:8px 0 0; font-size:12px; color:#6b6b6b;">Hostname: <code>' + escapeHtml(data.status || "?") + '</code> &middot; SSL: <code>' + escapeHtml(data.ssl_status || "?") + '</code></p>' +
      (ok ? '<p style="margin:10px 0 0; padding:10px 12px; background:#dcfce7; color:#166534; border-radius:6px; font-size:13px;">\\u2713 Live. Your share URLs now use <strong>' + escapeHtml(hostname) + '</strong>. Send students <code>https://' + escapeHtml(hostname) + '/&lt;funnel&gt;</code>.</p>' : cnameInstructions);
  } catch (err) {
    card.innerHTML = '<div style="padding:12px; background:#fdf0ed; color:#b84a3a; border-radius:6px; font-size:13px;">Status check failed: ' + escapeHtml(err.message) + '</div>';
  }
}

async function deleteCustomDomain(hostname) {
  if (!confirm("Remove " + hostname + " from this client? You'll need to re-register if you want to use it again.")) return;
  const pw = localStorage.getItem(STORAGE_KEY);
  try {
    await fetch("/admin/custom-domain/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw, hostname })
    });
    if (currentConfig) currentConfig.customDomain = "";
    const hiddenInput = document.querySelector('input[type="hidden"][data-key="customDomain"]');
    if (hiddenInput) hiddenInput.value = "";
    await save();
    renderCustomDomainCard();
    toast("Custom domain removed.");
  } catch (err) {
    toast("Error: " + err.message);
  }
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
  const courseSelected = courseRaw && courseRaw !== NEW_OPTION ? courseRaw.trim() : "";
  const course = courseSelected || "general"; // default funnel when editing brand-wide
  const box = document.getElementById("shareBox");
  if (!client) { box.style.display = "none"; return; }
  // Prefer the customer's custom domain if they set one; fall back to *.workers.dev origin
  const domainInput = document.querySelector('input[data-key="customDomain"]');
  let rawDomain = (domainInput && domainInput.value || "").trim();
  if (rawDomain.indexOf("https://") === 0) rawDomain = rawDomain.slice(8);
  else if (rawDomain.indexOf("http://") === 0) rawDomain = rawDomain.slice(7);
  while (rawDomain.endsWith("/")) rawDomain = rawDomain.slice(0, -1);
  // Custom-domain URLs use a clean /<funnel> path; default workers.dev uses /r/<client>/<funnel>
  const url = rawDomain
    ? "https://" + rawDomain + "/" + encodeURIComponent(course)
    : window.location.origin + "/r/" + encodeURIComponent(client) + "/" + encodeURIComponent(course);
  document.getElementById("shareUrl").value = url;
  document.getElementById("shareIframe").value =
    '<iframe src="' + url + '" allow="camera; microphone" style="width:100%;min-height:90vh;border:0;display:block;"></iframe>';
  document.getElementById("shareLabel").textContent =
    courseSelected ? (client + " / " + course) : (client + " / general — pick a funnel above for a specific page");
  box.style.display = "block";
  // Auto-load (or create) the short link for this funnel
  loadShortLink();
}

async function loadShortLink(opts) {
  const force = opts && opts.force;
  const pw = localStorage.getItem(STORAGE_KEY);
  const clientRaw = document.getElementById("clientName").value;
  const courseRaw = document.getElementById("courseName").value;
  const client = clientRaw && clientRaw !== NEW_OPTION ? clientRaw : "";
  const courseSelected = courseRaw && courseRaw !== NEW_OPTION ? courseRaw : "";
  const course = courseSelected || "general"; // default funnel when no specific one selected
  const input = document.getElementById("shareShort");
  if (!input) return;
  if (!client) { input.value = ""; input.placeholder = "Pick a client first"; return; }
  const domainInput = document.querySelector('input[data-key="customDomain"]');
  const preferredHost = (domainInput && domainInput.value || "").trim();
  input.value = "";
  input.placeholder = "Loading…";
  try {
    const res = await fetch("/admin/shortlink/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw, client, course, preferredHost, force: !!force })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ("Failed: " + res.status));
    input.value = data.full_url;
    input.placeholder = "";
    if (force) toast("New short link generated. Old one no longer works.");
  } catch (err) {
    input.placeholder = "Couldn't load: " + err.message;
  }
}

async function regenerateShortLink() {
  if (!confirm("Generate a fresh short link? The current one will stop working.")) return;
  await loadShortLink({ force: true });
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
  renderCustomDomainCard();
  // Render the wizard nav for whichever sub-tab is currently active
  const activeTab = document.querySelector(".sub-tab.active");
  if (activeTab) renderWizardNav(activeTab.dataset.subtab);
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
    iframe.onload = () => {
      // Once the iframe finishes loading, re-send the desired preview step + config
      pushPreviewStep(currentPreviewStep);
      const cfg = readForm();
      try { iframe.contentWindow.postMessage({ type: "VT_CONFIG_UPDATE", config: cfg }, "*"); } catch {}
    };
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

const SUB_TAB_ORDER = ["style", "welcome", "questions", "thankyou", "buttons", "settings", "share"];
const SUB_TAB_LABELS = {
  style: "Style",
  welcome: "Welcome message",
  questions: "Questions",
  thankyou: "Thank-you message",
  buttons: "Buttons",
  settings: "Settings",
  share: "Share"
};

// Map each sub-tab to which recorder step the live preview should show
const SUB_TAB_TO_PREVIEW_STEP = {
  style: "intro",
  welcome: "intro",
  questions: "question",
  thankyou: "done",
  buttons: "question",
  settings: "intro",
  share: "intro"
};
let currentPreviewStep = "intro";

function pushPreviewStep(step) {
  currentPreviewStep = step;
  const iframe = document.getElementById("livePreviewFrame");
  if (!iframe || !iframe.contentWindow) return;
  try {
    iframe.contentWindow.postMessage({ type: "VT_PREVIEW_STEP", step }, "*");
  } catch {}
}

function renderWizardNav(activeName) {
  const idx = SUB_TAB_ORDER.indexOf(activeName);
  const isFirst = idx === 0;
  const isLast = idx === SUB_TAB_ORDER.length - 1;
  const prevName = !isFirst ? SUB_TAB_ORDER[idx - 1] : null;
  const nextName = !isLast ? SUB_TAB_ORDER[idx + 1] : null;
  const stepText = "Step " + (idx + 1) + " of " + SUB_TAB_ORDER.length;

  document.querySelectorAll(".sub-panel").forEach(panel => {
    const nav = panel.querySelector(".wizard-nav");
    if (!nav) return;
    const panelName = panel.dataset.sub;
    if (panelName !== activeName) return;

    let html = "";
    if (prevName) {
      html += '<button class="prev" onclick="prevSubTab()">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" style="vertical-align:middle; margin-right:4px;"><polyline points="15 18 9 12 15 6"/></svg>' +
        'Back: ' + escapeHtml(SUB_TAB_LABELS[prevName]) +
        '</button>';
    } else {
      html += '<button class="prev" disabled style="visibility:hidden;">Back</button>';
    }
    html += '<span class="step-meta">' + escapeHtml(stepText) + '</span>';
    if (isLast) {
      html += '<button class="next" onclick="nextSubTab()">Save &amp; finish ✓</button>';
    } else {
      html += '<button class="next" onclick="nextSubTab()">Save &amp; next: ' + escapeHtml(SUB_TAB_LABELS[nextName]) +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" style="vertical-align:middle; margin-left:6px;"><polyline points="9 18 15 12 9 6"/></svg>' +
        '</button>';
    }
    nav.innerHTML = html;
  });
}

function switchSubTab(name) {
  document.querySelectorAll(".sub-tab").forEach(t => t.classList.toggle("active", t.dataset.subtab === name));
  document.querySelectorAll(".sub-panel").forEach(p => p.classList.toggle("active", p.dataset.sub === name));
  renderWizardNav(name);
  // Update share box visibility / load short link when arriving at Share
  if (name === "share") updateShareBox();
  // Tell the live preview iframe which screen to show (welcome/question/thank-you)
  pushPreviewStep(SUB_TAB_TO_PREVIEW_STEP[name] || "intro");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function nextSubTab() {
  const current = document.querySelector(".sub-tab.active");
  if (!current) return;
  const idx = SUB_TAB_ORDER.indexOf(current.dataset.subtab);
  if (idx === -1) return;
  await save(); // save before navigating forward
  if (idx < SUB_TAB_ORDER.length - 1) {
    switchSubTab(SUB_TAB_ORDER[idx + 1]);
  } else {
    toast("All set — your StokeReel is configured.");
  }
}

function prevSubTab() {
  const current = document.querySelector(".sub-tab.active");
  if (!current) return;
  const idx = SUB_TAB_ORDER.indexOf(current.dataset.subtab);
  if (idx > 0) switchSubTab(SUB_TAB_ORDER[idx - 1]);
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

// --------------------------------------------------------------
// Welcome page (post-Stripe-checkout deliverables)
// Stripe Payment Link redirect URL → https://stokereel.com/welcome
// --------------------------------------------------------------
const WELCOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Welcome to StokeReel</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231a1a1a'/%3E%3Cpolygon points='24,16 24,48 52,32' fill='%23c9a961'/%3E%3C/svg%3E">
<style>
  :root {
    --cream: #faf7f2;
    --ink: #1a1a1a;
    --warm: #c9a961;
    --warm-dark: #a88840;
    --muted: #6b6b6b;
    --border: #e5e0d6;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--cream); color: var(--ink); line-height: 1.6;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 56px 24px; }
  .badge {
    display: inline-block; padding: 4px 12px; border-radius: 999px;
    background: #dcfce7; color: #166534; font-size: 12px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 18px;
  }
  h1 { font-family: Georgia, serif; font-size: 42px; line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 14px; font-weight: 400; }
  h2 { font-family: Georgia, serif; font-size: 24px; margin: 40px 0 14px; font-weight: 400; }
  .lead { font-size: 18px; color: var(--muted); margin: 0 0 36px; }
  .card {
    background: white; border: 1px solid var(--border); border-radius: 12px;
    padding: 24px; margin-bottom: 18px;
  }
  .card .step-num {
    display: inline-flex; width: 28px; height: 28px; border-radius: 50%;
    background: var(--warm); color: white; font-weight: 700; font-size: 14px;
    align-items: center; justify-content: center; margin-right: 8px; vertical-align: middle;
  }
  .card h3 { display: inline; font-size: 18px; font-weight: 600; vertical-align: middle; margin: 0; }
  .card p { color: var(--muted); margin: 8px 0 14px; font-size: 15px; }
  .btn {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--ink); color: white; padding: 12px 22px; border-radius: 999px;
    text-decoration: none; font-size: 15px; font-weight: 600; border: none;
    cursor: pointer; transition: transform 0.15s, box-shadow 0.15s;
    box-shadow: 0 4px 12px rgba(0,0,0,0.12);
  }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(0,0,0,0.18); }
  .btn-secondary {
    background: transparent; color: var(--muted); border: 1px solid var(--border);
    box-shadow: none; padding: 10px 16px; font-size: 14px;
  }
  .btn-secondary:hover { background: white; color: var(--ink); }
  .email-block {
    background: var(--cream); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px; margin: 8px 0; font-size: 13px;
  }
  .email-meta { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; margin-bottom: 6px; }
  .email-subject { font-weight: 600; margin-bottom: 8px; font-size: 14px; }
  .email-body { white-space: pre-wrap; line-height: 1.55; color: #2a2a2a; }
  .copy-btn {
    background: white; color: var(--ink); border: 1px solid var(--border);
    padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600;
    cursor: pointer; margin-top: 8px;
  }
  .copy-btn:hover { background: var(--cream); }
  details summary {
    cursor: pointer; font-weight: 600; padding: 8px 0;
    color: var(--warm-dark);
  }
  ol { padding-left: 22px; line-height: 1.7; }
  ol li { margin-bottom: 6px; }
  code { background: var(--cream); padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  hr { border: none; border-top: 1px solid var(--border); margin: 40px 0; }
</style>
</head>
<body>
<div class="wrap">

  <div style="display:flex; align-items:center; gap:10px; margin: 0 0 14px;">
    <svg width="32" height="32" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#1a1a1a"/>
      <polygon points="24,16 24,48 52,32" fill="#c9a961"/>
    </svg>
    <span style="font-family: Georgia, serif; font-size: 18px; font-weight: 600;">StokeReel</span>
  </div>

  <span class="badge">✓ Payment received</span>
  <h1>Welcome to StokeReel.</h1>
  <p class="lead">Here's everything you just bought. The whole setup takes about 15 minutes — work through the cards in order.</p>

  <div class="card">
    <span class="step-num">1</span>
    <h3>Deploy StokeReel to your Cloudflare account</h3>
    <p>One click. Cloudflare auto-creates the worker + R2 bucket inside your own account. You own everything — videos, configs, infrastructure.</p>
    <a href="{{DEPLOY_URL}}" class="btn" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true"><path d="M12 2L2 19h20L12 2zm0 4l7.53 13H4.47L12 6z"/></svg>
      Deploy to Cloudflare
    </a>
    <details style="margin-top: 14px;">
      <summary>What happens after I click Deploy</summary>
      <ol style="margin-top: 10px;">
        <li>Cloudflare prompts you to sign in (or create a free account)</li>
        <li>Cloudflare authorizes GitHub access (forks the StokeReel repo into your GitHub)</li>
        <li>Cloudflare creates a Worker + R2 bucket in your account</li>
        <li>You get a URL like <code>https://stokereel.&lt;your-subdomain&gt;.workers.dev</code></li>
        <li>Visit <code>&lt;your-url&gt;/config</code> → setup wizard runs → you enter R2 keys + admin password (~5 min)</li>
        <li>Dashboard appears. You're live.</li>
      </ol>
    </details>
  </div>

  {{TIER_BLOCK}}

  <div class="card">
    <span class="step-num">2</span>
    <h3>Your 5-day testimonial collection sequence (template)</h3>
    <p>Fill-in-the-blank email template. Replace anything in <code>[BRACKETS]</code> with your specific program, gift, audience, and voice. Paste each into your email tool / GHL workflow / whatever sends your email.</p>
    <p><strong>Cadence:</strong> Email 1 immediately, then Days 3 / 6 / 10 / 14.</p>

    <div class="email-block">
      <div class="email-meta">Email 1 · The Ask</div>
      <div class="email-subject">Subject: a small favor (and something I'd like to give you)</div>
      <div class="email-body">Sent this to a handful of people who went through [PROGRAM NAME] with me.

I'm [OPENING IT AGAIN / LAUNCHING SOMETHING NEW / RUNNING THE NEXT ROUND] [TIMEFRAME, e.g. "next month"]. Before I do, I want to put real student stories on the page. Not testimonials. Stories. From the people who actually went through [THE PROGRAM] and came out the other side [SPECIFIC TRANSFORMATION, e.g. "hearing differently" / "playing with confidence" / "writing copy that converts"].

Yours is one I'd love to have.

If you'll record a short video for me, I want to give you something in return. [DESCRIBE THE GIFT — what it is, why it's valuable, why getting it now is special. 2-3 sentences max.]

Yours, on me, as a thank you.

I built a little page that makes recording the video easy. You click the link, it walks you through a few short questions, and you record your answer to each one right there on your phone or your computer. No app to download. No video to upload. Nothing to email me. The questions show up on the screen one at a time, so you don't need to remember anything or prepare.

Takes about 60 seconds.

[CTA TEXT, e.g. "Record your story →"]
[RECORDING PAGE URL]

A few things, in case you're worried:

You don't need to look polished. Hold your phone in front of you, prop it on a stack of books if your arm gets tired, and talk like you're [TELLING A FRIEND OVER COFFEE / NATURAL ANALOGY FOR YOUR AUDIENCE].

You can re-record if you flub it. There's a button.

People who hate being on camera do this beautifully. The thing that lands isn't polish. It's you, telling the truth.

Once you've recorded, I'll send the [GIFT NAME] over within a day or two.

[SIGN-OFF],
[YOUR NAME]

P.S. If you're worried your story isn't impressive enough — that's the story I want most. The quiet wins. [SPECIFIC SMALL-WIN EXAMPLE FROM YOUR WORLD, e.g. "The moment your ear started working" / "The first email that got a reply"]. That's the truth other [YOUR AUDIENCE, e.g. "guitarists" / "founders" / "writers"] need to hear.</div>
      <button class="copy-btn" onclick="copyEmail(this)">Copy</button>
    </div>

    <div class="email-block">
      <div class="email-meta">Email 2 · The Nudge · Day 3</div>
      <div class="email-subject">Subject: in case you missed it</div>
      <div class="email-body">Quick one.

Sent you something a few days ago about recording a short video for me. Sometimes my emails get buried, so I wanted to make sure it didn't slip past you.

The short version: I'm putting student stories on the page for [THE NEXT THING]. If you record a quick one — three questions, prompted on your phone, takes a minute — I'll send you [GIFT NAME, with brief reminder of why it's valuable] as a thank you.

Here's the link →
[RECORDING PAGE URL]

The page handles everything. No prep, no upload, no editing.

If you'd rather not, all good. I just didn't want you to miss it.

[SIGN-OFF],
[YOUR NAME]</div>
      <button class="copy-btn" onclick="copyEmail(this)">Copy</button>
    </div>

    <div class="email-block">
      <div class="email-meta">Email 3 · The Story · Day 6</div>
      <div class="email-subject">Subject: [SHORT, INTRIGUING SUBJECT REFERENCING THE STORY, e.g. "something Tom said to me at soundcheck" / "the email that almost got me fired"]</div>
      <div class="email-body">[OPENING SCENE — 2-4 short paragraphs. A specific moment from your life where someone or something made you confront the exact problem your program solves. Use real names, real places, real dialogue if you have it. Short sentences. One-line paragraphs.]

[THE LESSON LINE — one sentence stating what the moment taught you, written like a punch.]

[CONNECT TO YOUR PROGRAM — one sentence: "That [moment / question / lesson] is the whole reason [PROGRAM NAME] exists."]

I'm telling you this because I'm asking the people who went through [THE PROGRAM] to share their version of that moment. The thing they couldn't do before, that they can do now. [THE TRANSFORMATION, in their language.]

If you have one — and I'd bet you do — would you tell me about it on camera?

[CTA →]
[RECORDING PAGE URL]

The page walks you through three short prompts on your phone or computer. About a minute. And as a thank you, I'll send you [GIFT NAME].

[SIGN-OFF],
[YOUR NAME]

P.S. If your moment was a small one — a tiny shift, not a transformation — that's still the story I want. The small ones are usually the most honest.</div>
      <button class="copy-btn" onclick="copyEmail(this)">Copy</button>
    </div>

    <div class="email-block">
      <div class="email-meta">Email 4 · The Honest One · Day 10</div>
      <div class="email-subject">Subject: the part that's hard to ask for</div>
      <div class="email-body">I've been sitting on this email for a few days.

Asking for testimonials feels strange to me. I don't love doing it. Part of me would rather just [DO YOUR WORK / OPEN THE THING / LET THE WORK SPEAK].

But here's the thing.

When someone is on the fence about [DOING THE PROGRAM] — [SPECIFIC STAKES, e.g. "putting down real money, committing real time, trusting a stranger on the internet"] — what moves them isn't me telling them it works. It's [SOMEONE LIKE THEM], [SPECIFIC IMAGE, e.g. "sitting on their couch, looking into a phone"], saying "I was where you are, and now I'm not."

That's the only thing that actually moves people. I've seen it.

So if you've gotten something out of [THE PROGRAM], and you have a minute, would you record a short one for me?

Here's the link →
[RECORDING PAGE URL]

Three short prompts on the screen. About a minute. [GIFT NAME] is yours when you're done.

And if you'd rather not — really, truly, no pressure. The fact that you were in the room is enough.

[SIGN-OFF],
[YOUR NAME]</div>
      <button class="copy-btn" onclick="copyEmail(this)">Copy</button>
    </div>

    <div class="email-block">
      <div class="email-meta">Email 5 · Last Call · Day 14</div>
      <div class="email-subject">Subject: closing the window</div>
      <div class="email-body">Last note on this, then I'll stop asking.

I'm [WRAPPING UP THE PAGE / FINALIZING THE LAUNCH / FINISHING WHATEVER YOU'RE BUILDING] [SPECIFIC TIMEFRAME, e.g. "this weekend"]. After that, I'm heads-down on [THE NEXT THING] and I won't open this back up.

If you've been meaning to record one and just haven't sat down to do it — this is the moment.

[CTA →]
[RECORDING PAGE URL]

A minute on your phone. Three prompts. [GIFT NAME] in your inbox when you're done.

If you don't get to it, I understand. Thank you for being part of [THE PROGRAM / THE LAST ROUND / THE WORK] either way. Genuinely.

[SIGN-OFF],
[YOUR NAME]

P.S. If you started recording one and got self-conscious and closed the tab — happens to almost everyone. Open it back up. The first ten seconds are the hardest. After that you forget the camera is there.</div>
      <button class="copy-btn" onclick="copyEmail(this)">Copy</button>
    </div>
  </div>

  <div class="card">
    <span class="step-num">3</span>
    <h3>Fields you'll need to fill in</h3>
    <p>Same fields appear across the sequence. Fill them in once mentally, replace consistently.</p>
    <ul style="font-size: 14px; line-height: 1.8; margin-top: 12px; padding-left: 20px;">
      <li><strong>[PROGRAM NAME]</strong> — the cohort/course/program they bought</li>
      <li><strong>[OPENING IT AGAIN / etc.]</strong> — what you're doing next that needs the testimonials</li>
      <li><strong>[TIMEFRAME]</strong> — when you need them by</li>
      <li><strong>[SPECIFIC TRANSFORMATION]</strong> — the actual change your program produces, in plain language</li>
      <li><strong>[GIFT NAME + DESCRIPTION]</strong> — what you're giving them in exchange. Real value. Don't hype it.</li>
      <li><strong>[CTA TEXT]</strong> + <strong>[RECORDING PAGE URL]</strong> — appears in every email</li>
      <li><strong>[SIGN-OFF]</strong> — "Hugs," / "Talk soon," / "—" / whatever fits your voice</li>
      <li><strong>[YOUR NAME]</strong></li>
      <li><strong>[YOUR AUDIENCE]</strong> — what you call them ("guitarists" / "founders" / "copywriters")</li>
      <li><strong>[SMALL-WIN EXAMPLE]</strong> — the specific kind of quiet success you want stories about</li>
    </ul>
  </div>

  <div class="card">
    <span class="step-num">4</span>
    <h3>Get your recording page URL from the dashboard</h3>
    <p>After you complete the deploy in Step 1 and run the setup wizard, your dashboard shows a "Share & Embed" panel with three URL options. The <strong>Short link</strong> is best for emails — short, clean, easy to remember.</p>
    <p>Replace <code>[RECORDING PAGE URL]</code> in each email with that short link.</p>
  </div>

  <div class="card">
    <span class="step-num">5</span>
    <h3>Got stuck? Email me.</h3>
    <p>30 days of email support is included (60 days on the Agency plan). If something doesn't work or you need help, reply to your Stripe receipt or message me directly — 24-hour response time.</p>
    <p>Bookmark this page in case you need to come back. The deploy button and emails will always live here.</p>
  </div>

  <hr>

  <p style="text-align:center; color: var(--muted); font-size: 13px;">
    StokeReel · self-hosted · $0/mo forever
  </p>

</div>

<script>
function copyEmail(btn) {
  const block = btn.closest(".email-block");
  const subject = block.querySelector(".email-subject").textContent;
  const body = block.querySelector(".email-body").textContent;
  const text = subject + "\\n\\n" + body;
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = orig; }, 1800);
  }).catch(() => {
    btn.textContent = "Copy failed";
  });
}
</script>

</body>
</html>`;
