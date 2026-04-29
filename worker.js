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
// Version — bumped on every meaningful release. Customer workers compare
// this against UPSTREAM_VERSION_URL to detect when an update is available.
// Use semantic versioning (MAJOR.MINOR.PATCH).
// --------------------------------------------------------------
const STOKEREEL_VERSION = "1.1.0";
const UPSTREAM_VERSION_URL = "https://testimonials.michaelrochin.workers.dev/version";

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
      // /version — small JSON endpoint customer workers fetch from upstream to
      // detect when a newer release is available. CORS-open so any worker can
      // read it.
      if (url.pathname === "/version" && request.method === "GET") {
        return new Response(JSON.stringify({ version: STOKEREEL_VERSION }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=300",
            "Access-Control-Allow-Origin": "*"
          }
        });
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
        // Inject the current version + upstream URL so the dashboard JS can
        // run an update-available check on load.
        const html = CONFIG_HTML
          .replace("{{STOKEREEL_VERSION}}", STOKEREEL_VERSION)
          .replace("{{UPSTREAM_VERSION_URL}}", UPSTREAM_VERSION_URL);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
  startRecordingLabel: "Record",
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
  buttonStyle: "rounded",
  recordButtonShape: "rounded",
  recordButtonPlacement: "above-video",
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-feature-settings: "cv11", "ss01", "ss03";
    background: white;
    color: #1a1a1a;
    margin: 0;
    padding: 0;
    line-height: 1.5;
    font-feature-settings: "ss01" on, "cv11" on;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  h1 { font-family: "Fraunces", Georgia, serif; font-weight: 500; margin: 0 0 8px; letter-spacing: -0.02em; }
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
    grid-template-columns: minmax(0, 1fr) minmax(440px, 30vw);
    gap: 0;
    margin: 0;
    align-items: start;
  }
  @media (max-width: 1100px) {
    .layout { grid-template-columns: 1fr; }
    .rail { position: static !important; }
    .live-preview-panel { height: 600px !important; }
  }
  .rail {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
    background: white;
  }
  .rail-tip {
    background: transparent;
    border: 0;
    border-top: 1px solid #f0ebe0;
    border-radius: 0;
    padding: 16px 20px;
    box-shadow: none;
  }
  .rail-tip-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #c9a961;
    margin-bottom: 8px;
  }
  .rail-tip-body {
    margin: 0;
    font-size: 12.5px;
    color: #5a5550;
    line-height: 1.55;
  }
  .rail-tip-body strong { color: #1a1a1a; font-weight: 600; }
  /* Device-size tabs above the live preview — flat, no card */
  .device-tabs {
    display: flex;
    gap: 0;
    background: transparent;
    border: 0;
    border-radius: 0;
    padding: 10px 16px;
    box-shadow: none;
    width: 100%;
    border-bottom: 1px solid #f0ebe0;
    justify-content: center;
  }
  .device-tab {
    background: transparent !important;
    color: #9a9385 !important;
    border: none !important;
    padding: 6px 14px !important;
    font-size: 12px !important;
    font-weight: 500 !important;
    border-radius: 0 !important;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    transition: color 0.15s;
    box-shadow: none !important;
  }
  .device-tab:hover { color: #1a1a1a !important; }
  .device-tab.active {
    color: #1a1a1a !important;
    background: transparent !important;
    box-shadow: none !important;
  }
  .device-tab svg { flex-shrink: 0; }
  /* Device frame wrapper — scales an iframe at native device dimensions to fit the rail */
  .device-frame-wrap {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #faf7f2;
    position: relative;
  }
  .device-frame-wrap iframe {
    position: absolute;
    top: 0;
    left: 0;
    border: 0;
    display: block;
    background: white;
    transform-origin: top left;
    will-change: transform;
  }
  /* Desktop — fills the rail naturally, no transform scaling.
     Recorder is responsive, so this shows true WYSIWYG at the rail's actual width. */
  .device-frame-wrap.device-desktop iframe {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    transform: none !important;
  }
  /* Tablet — 768x1024 with device chrome */
  .device-frame-wrap.device-tablet iframe {
    width: 768px;
    height: 1024px;
    border-radius: 18px;
    border: 10px solid #1a1a1a;
    box-shadow: 0 12px 32px -8px rgba(0,0,0,0.25);
  }
  /* Mobile — 390x844 phone */
  .device-frame-wrap.device-mobile iframe {
    width: 390px;
    height: 844px;
    border-radius: 32px;
    border: 10px solid #1a1a1a;
    box-shadow: 0 12px 32px -8px rgba(0,0,0,0.25);
  }
  .live-preview-panel {
    border: 0;
    border-radius: 0;
    overflow: hidden;
    background: #faf7f2;
    height: calc(100vh - 220px);
    min-height: 480px;
    box-shadow: none;
  }
  .live-preview-header {
    padding: 8px 16px;
    border: 0;
    background: transparent;
    display: none;
    align-items: center;
    gap: 8px;
    font-size: 10px;
    color: #9a9385;
    text-transform: uppercase;
    letter-spacing: 0.1em;
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
    /* Sized via .device-frame-wrap.device-* rules above */
    background: white;
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
    background: transparent;
    border: 0;
    border-right: 1px solid #f0ebe0;
    border-radius: 0;
    padding: 28px 32px;
    box-shadow: none;
  }
  .section {
    margin-bottom: 28px;
    padding-bottom: 28px;
    border-bottom: 1px solid #f3eee2;
  }
  .section:first-of-type { padding-top: 0; }
  .section:last-child { border-bottom: none; padding-bottom: 0; margin-bottom: 0; }
  .section h2 {
    font-size: 16px; font-weight: 700; margin: 0 0 4px;
    letter-spacing: -0.005em;
    color: #1a1a1a;
    display: flex; align-items: center; gap: 8px;
    line-height: 1.25;
  }
  .section > .help-text:first-of-type,
  .section > p.help-text {
    margin: 0 0 16px;
    color: #6b6b6b;
    font-size: 12.5px;
  }
  /* Card-style sections — premium tool feel */
  .card-section {
    background: white;
    border: 1px solid #ede4cc;
    border-radius: 14px;
    margin-bottom: 18px;
    overflow: hidden;
    box-shadow: 0 1px 1px rgba(15,23,42,0.02);
    transition: border-color 0.18s, box-shadow 0.18s;
  }
  .card-section:hover {
    border-color: #d8d2c2;
    box-shadow: 0 1px 1px rgba(15,23,42,0.02), 0 4px 18px -10px rgba(15,23,42,0.10);
  }
  .card-section-head {
    padding: 18px 24px 14px;
    border-bottom: 1px solid #f6f1e3;
    background: linear-gradient(180deg, #fdfbf6 0%, #faf6ec 100%);
  }
  .card-section-head h2 {
    margin: 0 0 4px !important;
    padding: 0 !important;
    border: 0 !important;
    font-size: 16px !important;
    font-weight: 700 !important;
    color: #1a1a1a;
    letter-spacing: -0.005em;
  }
  .card-section-desc {
    margin: 0;
    font-size: 12.5px;
    color: #6b6b6b;
    line-height: 1.5;
  }
  .card-section-body {
    padding: 22px 24px 24px;
  }
  /* Logo row */
  .logo-row {
    display: flex;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
  }
  .logo-preview {
    width: 88px; height: 88px;
    border: 1.5px dashed #e5e0d6;
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    background: #faf7f2;
    font-size: 11px; color: #9a9385;
    overflow: hidden;
    flex-shrink: 0;
  }
  .logo-preview img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .logo-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .text-link-btn {
    background: transparent !important;
    color: #9a9385 !important;
    border: none !important;
    padding: 8px 8px !important;
    font-size: 13px !important;
    font-weight: 500 !important;
    text-decoration: underline;
    text-underline-offset: 2px;
    box-shadow: none !important;
  }
  .text-link-btn:hover { color: #b84a3a !important; }
  /* Advanced toggle (details/summary) */
  .advanced-toggle {
    margin-top: 16px;
    border-top: 1px dashed #ede4cc;
    padding-top: 14px;
  }
  .advanced-toggle summary {
    cursor: pointer;
    font-size: 12.5px;
    color: #6b6b6b;
    font-weight: 500;
    list-style: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    user-select: none;
  }
  .advanced-toggle summary::-webkit-details-marker { display: none; }
  .advanced-toggle summary::before {
    content: "+";
    width: 16px; height: 16px;
    border: 1px solid #d8d2c2;
    border-radius: 50%;
    display: inline-flex;
    align-items: center; justify-content: center;
    font-weight: 700;
    font-size: 12px;
    line-height: 1;
    color: #6b6b6b;
    transition: transform 0.18s;
  }
  .advanced-toggle[open] summary::before { content: "−"; }
  .advanced-toggle summary:hover { color: #1a1a1a; }
  /* Templates grid */
  .templates-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 10px;
  }
  /* Color grid — 2 columns, compact */
  .color-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px 18px;
  }
  @media (max-width: 720px) { .color-grid { grid-template-columns: 1fr; } }
  .color-cell { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .color-cell label {
    font-size: 12px;
    font-weight: 600;
    color: #5a5550;
    letter-spacing: 0.005em;
  }
  .color-input-row {
    display: flex;
    align-items: stretch;
    border: 1px solid #e5e0d6;
    border-radius: 10px;
    background: white;
    overflow: hidden;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .color-input-row:hover { border-color: #d8d2c2; }
  .color-input-row:focus-within {
    border-color: #c9a961;
    box-shadow: 0 0 0 3px rgba(201,169,97,0.18);
  }
  input[type="color"].color-swatch {
    width: 44px; height: 38px;
    padding: 4px !important;
    border: 0 !important;
    border-right: 1px solid #f0ebe0 !important;
    border-radius: 0 !important;
    background: white !important;
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: none !important;
  }
  input[type="color"].color-swatch::-webkit-color-swatch-wrapper { padding: 0; }
  input[type="color"].color-swatch::-webkit-color-swatch { border: 0; border-radius: 4px; }
  input[type="text"].color-hex {
    flex: 1;
    border: 0 !important;
    border-radius: 0 !important;
    padding: 8px 12px !important;
    font-family: ui-monospace, "SF Mono", monospace !important;
    font-size: 12.5px !important;
    background: white !important;
    color: #1a1a1a;
    box-shadow: none !important;
    min-width: 0;
  }
  input[type="text"].color-hex:focus { outline: none; }
  /* Shape selector */
  .shape-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  .shape-grid.two-col { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  @media (max-width: 720px) {
    .shape-grid, .shape-grid.two-col { grid-template-columns: 1fr; }
  }
  /* Placement demo (mini-mockups for record-button placement choice) */
  .placement-demo {
    width: 100%; max-width: 140px;
    background: #faf7f2;
    border: 1px solid #ede4cc;
    border-radius: 6px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: stretch;
  }
  .placement-line {
    height: 4px;
    background: #d8d2c2;
    border-radius: 2px;
  }
  .placement-btn {
    height: 14px;
    background: linear-gradient(180deg, #dc2626, #991b1b);
    border-radius: 4px;
    width: 60%;
    align-self: center;
  }
  .placement-video {
    height: 28px;
    background: #1a1a1a;
    border-radius: 4px;
    margin: 2px 0;
  }
  .shape-card {
    background: white !important;
    border: 1.5px solid #e5e0d6 !important;
    border-radius: 12px !important;
    padding: 14px 10px !important;
    color: #5a5550 !important;
    font-size: 12.5px !important;
    font-weight: 500 !important;
    cursor: pointer;
    box-shadow: none !important;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    transition: all 0.15s;
  }
  .shape-card:hover { border-color: #d8d2c2 !important; transform: translateY(-1px); }
  .shape-card.active {
    border-color: #1a1a1a !important;
    background: #fafaf7 !important;
    color: #1a1a1a !important;
    box-shadow: 0 0 0 3px rgba(26,26,26,0.06), 0 4px 12px -4px rgba(15,23,42,0.1) !important;
  }
  .shape-demo {
    width: 56px; height: 28px;
    background: linear-gradient(180deg, #c9a961, #b89752);
    color: white;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700;
  }
  .shape-demo-pill { border-radius: 999px; }
  .shape-demo-rounded { border-radius: 8px; }
  .shape-demo-sharp { border-radius: 2px; }
  .shape-demo-rsquare {
    width: 36px; height: 36px;
    background: linear-gradient(180deg, #dc2626, #991b1b);
    border-radius: 8px;
    font-size: 8px;
  }
  .shape-demo-square {
    width: 36px; height: 36px;
    background: linear-gradient(180deg, #dc2626, #991b1b);
    border-radius: 2px;
    font-size: 8px;
  }
  .shape-demo-circle {
    width: 36px; height: 36px;
    background: linear-gradient(180deg, #dc2626, #991b1b);
    border-radius: 50%;
    font-size: 8px;
  }
  /* Inline color picker (next to button preview) */
  .button-row {
    display: flex; align-items: center; gap: 12px; margin-top: 8px;
    flex-wrap: wrap;
  }
  .button-row .field-preview { margin-top: 0; flex: 1; min-width: 140px; }
  .inline-color {
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 11.5px; color: #6b6b6b;
    cursor: pointer;
    user-select: none;
    background: white;
    border: 1px solid #e5e0d6;
    padding: 4px 10px 4px 5px;
    border-radius: 999px;
    transition: border-color 0.15s, background 0.15s;
  }
  .inline-color:hover { border-color: #d8d2c2; background: #faf7f2; }
  .inline-color input[type="color"] {
    width: 22px; height: 22px;
    padding: 0 !important;
    border: 1px solid #e5e0d6 !important;
    border-radius: 50% !important;
    background: transparent !important;
    cursor: pointer;
    box-shadow: none !important;
  }
  .inline-color input[type="color"]::-webkit-color-swatch-wrapper { padding: 1px; }
  .inline-color input[type="color"]::-webkit-color-swatch { border: 0; border-radius: 50%; }
  .button-field { margin-bottom: 18px; }
  .button-field:last-child { margin-bottom: 0; }
  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 13px; color: #1a1a1a; margin-bottom: 6px; font-weight: 500; }
  .field input, .field textarea, .field select {
    width: 100%; padding: 11px 14px; border: 1px solid #e5e0d6; border-radius: 10px;
    font-size: 14px; font-family: inherit; background: white; color: #1a1a1a;
    box-shadow: inset 0 1px 1px rgba(15,23,42,0.02);
  }
  .field input:hover:not(:focus), .field textarea:hover:not(:focus), .field select:hover:not(:focus) {
    border-color: #d8d2c2;
  }
  .field textarea { resize: vertical; min-height: 72px; line-height: 1.55; }
  .field-row { display: grid; grid-template-columns: 80px 1fr; gap: 12px; align-items: center; }
  .field-row input[type=color] {
    width: 80px; height: 42px; padding: 2px;
    border: 1px solid #e5e0d6; border-radius: 8px;
    cursor: pointer; background: white;
  }
  .gate { max-width: 460px; margin: 64px auto; text-align: left; padding: 32px;
    background: white; border: 1px solid #e5e0d6; border-radius: 14px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 12px 36px -12px rgba(0,0,0,0.12);
  }
  .gate h1 {
    font-family: "Fraunces", Georgia, serif;
    font-size: 26px; font-weight: 600; margin: 0 0 8px;
    letter-spacing: -0.015em;
  }
  .gate .sub {
    font-size: 14px; color: #6b6b6b; line-height: 1.55;
    margin: 0 0 18px;
  }
  .gate input {
    width: 100%; padding: 13px 14px; border: 1px solid #e5e0d6;
    border-radius: 8px; font-size: 15px; margin: 4px 0 14px;
  }
  .gate button { width: 100%; }
  .gate-bookmark {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 12px 14px; margin: 0 0 22px;
    background: linear-gradient(180deg, #fbf6e8 0%, #f5ecd2 100%);
    border: 1px solid #ecdfb6;
    border-radius: 10px;
    color: #5a4a20;
    font-size: 12.5px; line-height: 1.5;
  }
  .gate-bookmark svg { color: #8a6f30; flex-shrink: 0; margin-top: 2px; }
  .gate-bookmark strong { display: block; color: #1a1a1a; font-weight: 600; margin-bottom: 1px; }
  .gate-bookmark span { color: #5a4a20; }
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
  /* Single unified shell — fills the entire viewport, no border, no margin */
  .app-shell {
    width: 100%;
    min-height: 100vh;
    background: white;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    overflow: visible;
  }
  /* Update-available banner — sits at the very top of the shell */
  .update-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 20px;
    background: linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 100%);
    color: white;
    font-size: 13px;
    font-weight: 500;
    border-bottom: 1px solid #000;
  }
  .update-banner-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px; height: 24px;
    border-radius: 50%;
    background: linear-gradient(180deg, #c9a961, #b89752);
    color: #1a1a1a;
    flex-shrink: 0;
  }
  .update-banner-text { flex: 1; }
  .update-banner-versions {
    color: #9a9385;
    margin-left: 6px;
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 12px;
  }
  .update-banner-btn {
    background: white !important;
    color: #1a1a1a !important;
    border: 0 !important;
    padding: 6px 14px !important;
    font-size: 12.5px !important;
    font-weight: 600 !important;
    border-radius: 6px !important;
    cursor: pointer;
    box-shadow: none !important;
  }
  .update-banner-btn:hover { background: #faf7f2 !important; }
  .update-banner-dismiss {
    background: transparent !important;
    color: #9a9385 !important;
    border: 0 !important;
    padding: 4px 10px !important;
    font-size: 18px !important;
    cursor: pointer;
    box-shadow: none !important;
    line-height: 1;
  }
  .update-banner-dismiss:hover { color: white !important; }
  /* App header (inside shell — no border/bg of its own) */
  .app-header {
    background: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    overflow: visible;
    margin: 0;
  }
  .brand-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 24px;
    border-bottom: 1px solid #f0ebe0;
    gap: 20px; flex-wrap: wrap;
  }
  .brand-mark { display: flex; align-items: center; gap: 12px; }
  .brand-mark svg { flex-shrink: 0; width: 26px; height: 26px; }
  .brand-name {
    font-family: "Fraunces", Georgia, serif;
    font-size: 18px; font-weight: 600; color: #1a1a1a;
    letter-spacing: -0.015em; line-height: 1;
  }
  .brand-tag {
    font-size: 11.5px; color: #9a9385; margin-top: 3px;
    letter-spacing: 0;
  }
  .brand-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .ghost-btn {
    background: transparent !important;
    color: #6b6b6b !important;
    border: 1px solid transparent !important;
    padding: 7px 14px !important;
    font-size: 13px !important;
    font-weight: 500 !important;
    border-radius: 8px !important;
    box-shadow: none !important;
  }
  .ghost-btn:hover { background: #faf7f2 !important; color: #1a1a1a !important; }

  /* Workspace bar — client + funnel + save (tight, no dead space) */
  .workspace-bar {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 10px 24px;
    background: transparent;
    border-bottom: 1px solid #f0ebe0;
  }
  .ws-group { display: inline-flex; align-items: center; gap: 8px; }
  .ws-label {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #9a8550;
    white-space: nowrap;
  }
  .ws-select-wrap { display: flex; gap: 6px; align-items: center; }
  .ws-select {
    appearance: none; -webkit-appearance: none;
    padding: 7px 32px 7px 12px !important;
    border: 1px solid #e5e0d6 !important;
    border-radius: 8px !important;
    background-color: white !important;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none' stroke='%236b6b6b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='1 1.5 6 6.5 11 1.5'/></svg>") !important;
    background-repeat: no-repeat !important;
    background-position: right 12px center !important;
    font-size: 13.5px !important;
    font-weight: 500;
    color: #1a1a1a;
    min-width: 200px;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .ws-select:hover { border-color: #d8d2c2 !important; }
  .ws-select:focus { outline: none; border-color: #c9a961 !important; box-shadow: 0 0 0 3px rgba(201,169,97,0.18); }
  .ws-add {
    display: inline-flex; align-items: center; gap: 5px;
    background: white !important;
    color: #1a1a1a !important;
    border: 1px solid #e5e0d6 !important;
    padding: 8px 12px !important;
    border-radius: 10px !important;
    font-size: 12.5px !important;
    font-weight: 500 !important;
    cursor: pointer;
    box-shadow: 0 1px 1px rgba(15,23,42,0.03) !important;
    transition: all 0.15s;
  }
  .ws-add:hover {
    background: #1a1a1a !important;
    color: white !important;
    border-color: #1a1a1a !important;
    transform: translateY(-1px);
  }
  .ws-add svg { flex-shrink: 0; }
  .ws-divider {
    width: 1px;
    height: 22px;
    background: #ede4cc;
    align-self: center;
  }
  .ws-spacer { flex: 1; }
  .ws-scope-badge {
    font-size: 12px;
    font-weight: 500;
    color: #5a5550;
    background: transparent;
    border: 0;
    padding: 0 4px;
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    line-height: 1;
  }
  .ws-scope-dot {
    width: 8px; height: 8px; border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 0 2px rgba(255,255,255,0.6);
  }
  .ws-save {
    align-self: center;
    background: linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 100%) !important;
    color: white !important;
    border: 0 !important;
    padding: 8px 16px !important;
    font-size: 13px !important;
    font-weight: 600 !important;
    border-radius: 8px !important;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.1) !important;
  }
  .ws-save:hover {
    background: linear-gradient(180deg, #2a2a2a 0%, #1a1a1a 100%) !important;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 2px 6px rgba(0,0,0,0.15) !important;
  }
  .ws-delete {
    align-self: center;
    background: transparent !important;
    color: #b84a3a !important;
    border: 0 !important;
    padding: 8px 10px !important;
    font-size: 12.5px !important;
    border-radius: 6px !important;
    box-shadow: none !important;
  }
  .ws-delete:hover { background: #fdf0ed !important; }
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
    padding: 4px;
    background: #faf7f2;
    border: 1px solid #ede4cc;
    border-radius: 999px;
    width: fit-content;
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
    display: flex;
    justify-content: space-between;
    gap: 2px; margin: 0; flex-wrap: wrap;
    background: linear-gradient(180deg, #f7f2e6 0%, #f1ebd8 100%);
    border: 0;
    border-top: 1px solid #ede4cc;
    border-bottom: 1px solid #ede4cc;
    border-radius: 0; padding: 0 24px; width: 100%;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.6);
    overflow-x: auto;
  }
  .sub-tab {
    background: transparent !important; border: none !important;
    padding: 14px 14px 13px !important; cursor: pointer;
    font-size: 13px !important; font-weight: 500 !important;
    color: #7a6f54 !important; font-family: inherit;
    border-radius: 0 !important;
    border-bottom: 2px solid transparent !important;
    margin-bottom: -1px;
    transition: color 0.15s, border-color 0.15s; box-shadow: none !important;
  }
  .sub-tab:hover { color: #1a1a1a !important; transform: none !important; }
  .sub-tab.active {
    color: #1a1a1a !important;
    border-bottom-color: #1a1a1a !important;
    background: transparent !important;
    font-weight: 600 !important;
  }
  .sub-tab.active:hover { color: #1a1a1a !important; }
  .sub-panel { display: none; }
  .sub-panel.active { display: block; animation: vt-fade-in 0.18s ease; }
  @keyframes vt-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .sub-panel-hint { display: none; }
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
  /* Section eyebrow — small uppercase label above H2 */
  .section-eyebrow {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #c9a961;
    margin-bottom: 8px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .section-eyebrow::before {
    content: "";
    width: 16px;
    height: 1px;
    background: #c9a961;
    display: inline-block;
  }
  /* Email cards */
  .email-card {
    background: white;
    border: 1px solid #e5e0d6;
    border-radius: 12px;
    padding: 18px 20px 16px;
    margin-bottom: 14px;
    transition: border-color 0.18s, box-shadow 0.18s;
  }
  .email-card:hover {
    border-color: #d8d2c2;
    box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 6px 18px -8px rgba(15,23,42,0.08);
  }
  .email-card-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 12px;
  }
  .email-day {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #9a8550;
    background: linear-gradient(180deg, #fbf6e8 0%, #f5ecd2 100%);
    border: 1px solid #ecdfb6;
    padding: 5px 12px;
    border-radius: 999px;
  }
  .email-subject-line {
    font-size: 14px;
    font-weight: 600;
    color: #1a1a1a;
    padding: 10px 14px;
    background: #faf7f2;
    border: 1px solid #ede8dc;
    border-radius: 8px;
    margin-bottom: 10px;
  }
  .email-body-line {
    font-family: ui-monospace, "SF Mono", "Monaco", monospace;
    font-size: 12.5px;
    line-height: 1.65;
    color: #2a2a2a;
    padding: 14px 16px;
    background: #faf7f2;
    border: 1px solid #ede8dc;
    border-radius: 8px;
    white-space: pre-wrap;
    word-wrap: break-word;
    max-height: 240px;
    overflow-y: auto;
    margin-bottom: 12px;
  }
  .email-body-line code {
    background: rgba(201,169,97,0.16);
    color: #8a6f30;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11.5px;
    font-weight: 600;
  }
  .copy-btn-pro {
    background: linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 100%) !important;
    color: white !important;
    border: none !important;
    padding: 9px 16px !important;
    border-radius: 8px !important;
    font-size: 12.5px !important;
    font-weight: 600 !important;
    cursor: pointer;
    transition: all 0.15s;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.1),
      0 1px 2px rgba(0,0,0,0.1);
  }
  .copy-btn-pro:hover {
    background: linear-gradient(180deg, #2a2a2a 0%, #1a1a1a 100%) !important;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.12),
      0 2px 8px rgba(0,0,0,0.18);
  }
  .copy-btn-pro.copied {
    background: linear-gradient(180deg, #2a8552 0%, #1f6c41 100%) !important;
  }
  /* Reference list */
  .reference-list {
    list-style: none;
    padding: 0;
    margin: 0;
    background: white;
    border: 1px solid #e5e0d6;
    border-radius: 12px;
    overflow: hidden;
  }
  .reference-list li {
    padding: 11px 18px;
    border-bottom: 1px solid #f0ebe0;
    font-size: 13px;
    color: #4a4a4a;
    line-height: 1.5;
  }
  .reference-list li:last-child { border-bottom: none; }
  .reference-list strong {
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 12px;
    color: #8a6f30;
    background: rgba(201,169,97,0.12);
    padding: 1px 6px;
    border-radius: 4px;
    margin-right: 6px;
    font-weight: 600;
  }
  /* Premium polish — toggles, selects, color pickers */
  .toggle-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px;
    background: white;
    border: 1px solid #e5e0d6;
    border-radius: 10px;
    margin-bottom: 8px;
    transition: border-color 0.15s;
  }
  .toggle-row:hover { border-color: #d8d2c2; }
  .toggle-row .toggle-label {
    font-size: 13.5px;
    color: #1a1a1a;
    font-weight: 500;
  }
  .toggle-row .toggle-label small {
    display: block;
    font-size: 11.5px;
    color: #9a9385;
    font-weight: 400;
    margin-top: 2px;
  }
  .toggle-switch {
    position: relative;
    width: 40px;
    height: 22px;
    flex-shrink: 0;
    cursor: pointer;
  }
  .toggle-switch input {
    opacity: 0; width: 0; height: 0; position: absolute;
  }
  .toggle-switch .slider {
    position: absolute; inset: 0;
    background: #e5e0d6;
    border-radius: 999px;
    transition: background 0.18s;
  }
  .toggle-switch .slider::before {
    content: "";
    position: absolute;
    width: 18px; height: 18px;
    left: 2px; top: 2px;
    background: white;
    border-radius: 50%;
    transition: transform 0.18s;
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  }
  .toggle-switch input:checked + .slider {
    background: linear-gradient(180deg, #c9a961, #b89752);
  }
  .toggle-switch input:checked + .slider::before {
    transform: translateX(18px);
  }
  /* Custom select with chevron */
  select.premium-select {
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none' stroke='%236b6b6b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='1 1.5 6 6.5 11 1.5'/></svg>");
    background-repeat: no-repeat;
    background-position: right 14px center;
    padding-right: 38px !important;
    cursor: pointer;
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
  /* Submissions tab — premium toolbar */
  .subs-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 24px;
    border-bottom: 1px solid #f0ebe0;
    background: #fdfbf6;
    gap: 14px;
    flex-wrap: wrap;
  }
  .subs-count-wrap { display: flex; align-items: baseline; gap: 8px; }
  .subs-count {
    font-size: 13px;
    font-weight: 600;
    color: #1a1a1a;
    letter-spacing: -0.005em;
  }
  .subs-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .subs-btn-ghost {
    display: inline-flex; align-items: center; gap: 6px;
    background: transparent !important;
    color: #5a5550 !important;
    border: 1px solid #e5e0d6 !important;
    padding: 7px 12px !important;
    font-size: 12.5px !important;
    font-weight: 500 !important;
    border-radius: 8px !important;
    box-shadow: none !important;
    cursor: pointer;
  }
  .subs-btn-ghost:hover { background: white !important; color: #1a1a1a !important; }
  .subs-btn-primary {
    display: inline-flex; align-items: center; gap: 6px;
    background: linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 100%) !important;
    color: white !important;
    border: 0 !important;
    padding: 7px 14px !important;
    font-size: 12.5px !important;
    font-weight: 600 !important;
    border-radius: 8px !important;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.1) !important;
    cursor: pointer;
  }
  .subs-btn-primary:hover {
    background: linear-gradient(180deg, #2a2a2a 0%, #1a1a1a 100%) !important;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 2px 6px rgba(0,0,0,0.15) !important;
  }
  /* Submissions content area */
  .subs-content { padding: 24px; }
  .submissions-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 20px;
  }
  /* Submission card — premium look */
  .sub-card {
    background: white;
    border: 1px solid #ede4cc;
    border-radius: 14px;
    overflow: hidden;
    transition: border-color 0.18s, box-shadow 0.18s, transform 0.18s;
    display: flex;
    flex-direction: column;
  }
  .sub-card:hover {
    border-color: #d8d2c2;
    box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 12px 32px -10px rgba(15,23,42,0.12);
    transform: translateY(-2px);
  }
  .sub-card video {
    width: 100%;
    aspect-ratio: 4 / 3;
    height: auto;
    object-fit: cover;
    background: #0a0a0a;
    display: block;
  }
  .sub-text { padding: 14px 16px 4px; }
  .sub-text .answer {
    background: #faf7f2;
    padding: 10px 12px;
    border-radius: 8px;
    margin: 6px 0;
    font-size: 13px;
    line-height: 1.5;
  }
  .sub-text .answer-q {
    font-weight: 600;
    font-size: 11px;
    color: #9a8550;
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .sub-meta {
    padding: 14px 16px;
    border-top: 1px solid #f3eee2;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: #fdfbf6;
  }
  .sub-meta .name {
    font-weight: 600;
    font-size: 14px;
    color: #1a1a1a;
    letter-spacing: -0.005em;
  }
  .sub-meta .email {
    color: #6b6b6b;
    font-size: 12.5px;
    font-family: ui-monospace, "SF Mono", monospace;
  }
  .sub-meta .date {
    color: #9a9385;
    font-size: 11.5px;
    margin-top: 6px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sub-meta .date::before {
    content: "";
    width: 4px; height: 4px;
    background: #c9a961;
    border-radius: 50%;
    display: inline-block;
  }
  /* Feature toggle button on each submission card */
  .feature-toggle {
    align-self: flex-start;
    margin-top: 10px;
    background: white !important;
    color: #6b6b6b !important;
    border: 1px solid #e5e0d6 !important;
    padding: 5px 12px !important;
    font-size: 11.5px !important;
    font-weight: 500 !important;
    border-radius: 999px !important;
    box-shadow: none !important;
    cursor: pointer;
    transition: all 0.15s;
  }
  .feature-toggle:hover {
    border-color: #c9a961 !important;
    color: #1a1a1a !important;
    background: #fdfbf6 !important;
  }
  .feature-toggle.is-featured {
    background: linear-gradient(180deg, #fbf6e8, #f5ecd2) !important;
    border-color: #ecdfb6 !important;
    color: #8a6f30 !important;
    font-weight: 600 !important;
  }
  /* Empty / loading state */
  .sub-empty {
    grid-column: 1 / -1;
    text-align: center;
    padding: 80px 24px;
    color: #9a9385;
    font-size: 14px;
    border: 1.5px dashed #ede4cc;
    border-radius: 14px;
    background: #fdfbf6;
  }
  .sub-badge { display: inline-block; background: #faf7f2; border: 1px solid #e5e0d6; padding: 2px 8px; border-radius: 12px; font-size: 11px; color: #6b6b6b; margin-left: 6px; }
  .sub-badge.text { background: #eef4ff; border-color: #c8d8f4; color: #2a4a8a; }
  .sub-empty { text-align: center; color: #6b6b6b; padding: 60px 20px; grid-column: 1 / -1; }

  /* ==========================================================
     DARK THEME — OVERRIDE LAYER
     Re-themes the dashboard to a near-black, edgy AI aesthetic.
     Sits at the bottom of the cascade so it wins over all the
     light-mode styles defined above.
     ========================================================== */
  :root {
    --d-bg: #050505;
    --d-bg-2: #0e0e0e;
    --d-bg-3: #161616;
    --d-bg-4: #1c1c1c;
    --d-ink: #fafafa;
    --d-ink-2: #c4c4c4;
    --d-muted: #8a8a8a;
    --d-muted-2: #5a5a5a;
    --d-border: rgba(255,255,255,0.08);
    --d-border-strong: rgba(255,255,255,0.16);
    --d-warm: #d4b673;
    --d-warm-bright: #fbd86e;
  }
  body {
    background: var(--d-bg) !important;
    color: var(--d-ink) !important;
    background-image:
      radial-gradient(1100px 700px at 100% -10%, rgba(212,182,115,0.08), transparent 55%),
      radial-gradient(900px 600px at -10% 100%, rgba(212,182,115,0.04), transparent 60%) !important;
  }
  .app-shell {
    background: transparent !important;
    border: 0 !important;
    box-shadow: none !important;
  }
  /* Login gate */
  .gate {
    background: var(--d-bg-2) !important;
    border: 1px solid var(--d-border-strong) !important;
    box-shadow: 0 24px 60px -12px rgba(0,0,0,0.6) !important;
  }
  .gate h1 { color: var(--d-ink) !important; }
  .gate .sub { color: var(--d-ink-2) !important; }
  .gate input {
    background: var(--d-bg-3) !important;
    border-color: var(--d-border) !important;
    color: var(--d-ink) !important;
  }
  .gate input::placeholder { color: var(--d-muted-2); }
  .gate-bookmark {
    background: linear-gradient(180deg, rgba(212,182,115,0.10), rgba(212,182,115,0.04)) !important;
    border-color: rgba(212,182,115,0.25) !important;
    color: var(--d-ink-2) !important;
  }
  .gate-bookmark strong { color: var(--d-ink) !important; }
  .gate-bookmark span { color: var(--d-ink-2) !important; }
  .gate-bookmark svg { color: var(--d-warm-bright) !important; }
  /* Brand row + workspace bar */
  .brand-row {
    border-bottom-color: var(--d-border) !important;
  }
  .brand-name { color: var(--d-ink) !important; }
  .brand-tag { color: var(--d-muted) !important; }
  .ghost-btn { color: var(--d-muted) !important; }
  .ghost-btn:hover { background: var(--d-bg-2) !important; color: var(--d-ink) !important; }
  .workspace-bar {
    background: var(--d-bg-2) !important;
    border-bottom-color: var(--d-border) !important;
  }
  .ws-label { color: var(--d-warm) !important; }
  .ws-select {
    background-color: var(--d-bg-3) !important;
    border-color: var(--d-border) !important;
    color: var(--d-ink) !important;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none' stroke='%23a0a0a0' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='1 1.5 6 6.5 11 1.5'/></svg>") !important;
  }
  .ws-select:hover { border-color: var(--d-border-strong) !important; }
  .ws-add {
    background: var(--d-bg-3) !important;
    border-color: var(--d-border) !important;
    color: var(--d-ink-2) !important;
  }
  .ws-add:hover {
    background: var(--d-warm) !important;
    border-color: var(--d-warm) !important;
    color: #0a0a0a !important;
  }
  .ws-divider { background: var(--d-border) !important; }
  .ws-scope-badge { color: var(--d-ink-2) !important; }
  /* Tabs (Configure / Submissions) */
  .tabs {
    background: var(--d-bg-3) !important;
    border-color: var(--d-border) !important;
  }
  .tab { color: var(--d-muted) !important; }
  .tab:hover { color: var(--d-ink) !important; background: rgba(255,255,255,0.04) !important; }
  .tab.active {
    background: linear-gradient(180deg, #f0d57a 0%, #c9a961 100%) !important;
    color: #0a0a0a !important;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.4), 0 4px 14px -4px rgba(212,182,115,0.4) !important;
  }
  .tab.active:hover { background: linear-gradient(180deg, #f0d57a 0%, #c9a961 100%) !important; color: #0a0a0a !important; }
  /* Sub-tabs (Style / Welcome / Questions / etc) */
  .sub-tabs {
    background: linear-gradient(180deg, rgba(212,182,115,0.06) 0%, rgba(212,182,115,0.02) 100%) !important;
    border-top-color: var(--d-border) !important;
    border-bottom-color: var(--d-border) !important;
    box-shadow: none !important;
  }
  .sub-tab { color: var(--d-muted) !important; }
  .sub-tab:hover { color: var(--d-ink) !important; }
  .sub-tab.active {
    color: var(--d-ink) !important;
    border-bottom-color: var(--d-warm) !important;
  }
  /* Panel + sections */
  .panel {
    background: transparent !important;
    border-right-color: var(--d-border) !important;
  }
  .section { border-bottom-color: var(--d-border) !important; }
  .section h2 { color: var(--d-ink) !important; }
  .help-text, p.help-text, .section .help-text { color: var(--d-muted) !important; }
  .section-eyebrow { color: var(--d-warm) !important; }
  .section-eyebrow::before { background: var(--d-warm) !important; }
  /* Form fields */
  .field label { color: var(--d-ink-2) !important; }
  .field input, .field textarea, .field select {
    background: var(--d-bg-3) !important;
    border-color: var(--d-border) !important;
    color: var(--d-ink) !important;
    box-shadow: none !important;
  }
  .field input::placeholder, .field textarea::placeholder { color: var(--d-muted-2); }
  .field input:hover:not(:focus), .field textarea:hover:not(:focus), .field select:hover:not(:focus) {
    border-color: var(--d-border-strong) !important;
  }
  input[type="text"]:focus, input[type="number"]:focus, input[type="email"]:focus, input[type="password"]:focus, textarea:focus, select:focus {
    border-color: var(--d-warm) !important;
    box-shadow: 0 0 0 3px rgba(212,182,115,0.18) !important;
  }
  /* Color grid */
  .color-cell label { color: var(--d-ink-2) !important; }
  .color-input-row {
    background: var(--d-bg-3) !important;
    border-color: var(--d-border) !important;
  }
  .color-input-row:hover { border-color: var(--d-border-strong) !important; }
  input[type="color"].color-swatch {
    background: var(--d-bg-3) !important;
    border-right-color: var(--d-border) !important;
  }
  input[type="text"].color-hex {
    background: var(--d-bg-3) !important;
    color: var(--d-ink) !important;
  }
  /* Toggle switches */
  .toggle-row {
    background: var(--d-bg-3) !important;
    border-color: var(--d-border) !important;
  }
  .toggle-row:hover { border-color: var(--d-border-strong) !important; }
  .toggle-row .toggle-label { color: var(--d-ink) !important; }
  .toggle-row .toggle-label small { color: var(--d-muted) !important; }
  .toggle-switch .slider { background: var(--d-bg-4); }
  /* Shape cards */
  .shape-card {
    background: var(--d-bg-3) !important;
    border-color: var(--d-border) !important;
    color: var(--d-ink-2) !important;
  }
  .shape-card:hover { border-color: var(--d-border-strong) !important; }
  .shape-card.active {
    border-color: var(--d-warm) !important;
    background: rgba(212,182,115,0.08) !important;
    color: var(--d-ink) !important;
    box-shadow: 0 0 0 3px rgba(212,182,115,0.15), 0 8px 20px -6px rgba(212,182,115,0.3) !important;
  }
  .placement-demo {
    background: var(--d-bg-4) !important;
    border-color: var(--d-border) !important;
  }
  .placement-line { background: var(--d-border-strong) !important; }
  .placement-video { background: #000 !important; }
  /* Logo upload */
  .logo-preview {
    background: var(--d-bg-3) !important;
    border-color: var(--d-border-strong) !important;
    color: var(--d-muted) !important;
  }
  .text-link-btn { color: var(--d-muted) !important; }
  .text-link-btn:hover { color: #ef4444 !important; }
  /* Premium select chevron */
  select.premium-select {
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none' stroke='%23a0a0a0' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='1 1.5 6 6.5 11 1.5'/></svg>") !important;
  }
  /* Buttons */
  button:not(.tab):not(.sub-tab):not(.copy-btn):not(.ws-add):not(.ws-save):not(.ws-delete):not(.text-link-btn):not(.shape-card):not(.toggle-switch):not(.subs-btn-ghost):not(.subs-btn-primary):not(.update-banner-btn):not(.update-banner-dismiss):not(.feature-toggle):not(.copy-btn-pro):not(.device-tab) {
    background: linear-gradient(180deg, #f0d57a 0%, #c9a961 100%) !important;
    color: #0a0a0a !important;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.4), 0 4px 14px -4px rgba(212,182,115,0.45) !important;
  }
  button.secondary {
    background: var(--d-bg-3) !important;
    color: var(--d-ink) !important;
    border-color: var(--d-border-strong) !important;
    box-shadow: none !important;
  }
  button.secondary:hover {
    background: var(--d-bg-4) !important;
    border-color: rgba(212,182,115,0.4) !important;
    color: var(--d-warm-bright) !important;
  }
  /* Wizard nav */
  .wizard-nav { border-top-color: var(--d-border) !important; }
  .wizard-nav button.next {
    background: linear-gradient(180deg, #f0d57a 0%, #c9a961 100%) !important;
    color: #0a0a0a !important;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.4), 0 4px 14px -4px rgba(212,182,115,0.4) !important;
  }
  .wizard-nav button.next:hover:not(:disabled) {
    filter: brightness(1.08);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.5), 0 8px 24px -4px rgba(212,182,115,0.55) !important;
  }
  .wizard-nav button.prev {
    background: var(--d-bg-3) !important;
    color: var(--d-ink-2) !important;
    border-color: var(--d-border-strong) !important;
  }
  .wizard-nav button.prev:hover:not(:disabled) {
    background: var(--d-bg-4) !important;
    color: var(--d-ink) !important;
  }
  .wizard-nav .step-meta { color: var(--d-muted) !important; }
  /* Live preview rail */
  .rail { background: transparent !important; }
  .device-tabs { border-bottom-color: var(--d-border) !important; }
  .device-tab { color: var(--d-muted-2) !important; }
  .device-tab:hover { color: var(--d-ink) !important; }
  .device-tab.active { color: var(--d-ink) !important; }
  .live-preview-panel { background: #000 !important; }
  .device-frame-wrap { background: #000 !important; }
  .live-preview-empty { color: var(--d-muted) !important; }
  .rail-tip { border-top-color: var(--d-border) !important; }
  .rail-tip-eyebrow { color: var(--d-warm) !important; }
  .rail-tip-body { color: var(--d-ink-2) !important; }
  .rail-tip-body strong { color: var(--d-ink) !important; }
  /* Share + email cards */
  .share-card, .email-card, .reference-list {
    background: var(--d-bg-2) !important;
    border-color: var(--d-border) !important;
  }
  .share-card:hover, .email-card:hover { border-color: var(--d-border-strong) !important; }
  .share-card-head strong { color: var(--d-ink) !important; }
  .share-tag, .share-desc { color: var(--d-muted) !important; }
  .share-input-row input {
    background: var(--d-bg-3) !important;
    border-color: var(--d-border) !important;
    color: var(--d-ink) !important;
  }
  .share-input-row input:focus { background: var(--d-bg-4) !important; border-color: var(--d-warm) !important; }
  .email-subject-line, .email-body-line {
    background: var(--d-bg-3) !important;
    border-color: var(--d-border) !important;
    color: var(--d-ink-2) !important;
  }
  .email-body-line code { background: rgba(212,182,115,0.16) !important; color: var(--d-warm-bright) !important; }
  .reference-list li {
    color: var(--d-ink-2) !important;
    border-bottom-color: var(--d-border) !important;
  }
  /* Submissions */
  .subs-toolbar {
    background: var(--d-bg-2) !important;
    border-bottom-color: var(--d-border) !important;
  }
  .subs-count { color: var(--d-ink) !important; }
  .subs-btn-ghost {
    background: var(--d-bg-3) !important;
    color: var(--d-ink-2) !important;
    border-color: var(--d-border-strong) !important;
  }
  .subs-btn-ghost:hover { background: var(--d-bg-4) !important; color: var(--d-ink) !important; }
  .sub-card {
    background: var(--d-bg-2) !important;
    border-color: var(--d-border) !important;
  }
  .sub-card:hover { border-color: var(--d-border-strong) !important; }
  .sub-meta {
    background: var(--d-bg-3) !important;
    border-top-color: var(--d-border) !important;
  }
  .sub-meta .name { color: var(--d-ink) !important; }
  .sub-meta .email { color: var(--d-muted) !important; }
  .sub-meta .date { color: var(--d-muted-2) !important; }
  .sub-text .answer {
    background: var(--d-bg-3) !important;
    color: var(--d-ink-2) !important;
  }
  .sub-text .answer-q { color: var(--d-warm) !important; }
  .feature-toggle {
    background: var(--d-bg-3) !important;
    color: var(--d-ink-2) !important;
    border-color: var(--d-border-strong) !important;
  }
  .feature-toggle:hover {
    background: var(--d-bg-4) !important;
    border-color: var(--d-warm) !important;
    color: var(--d-warm-bright) !important;
  }
  .sub-empty {
    background: var(--d-bg-2) !important;
    border-color: var(--d-border-strong) !important;
    color: var(--d-muted) !important;
  }
  /* Toast */
  /* (already dark — keep) */
  /* Forgot / Update modals — already explicitly white-on-dark, keep light-content modal as-is for readability */
  /* Misc text */
  h1, h2, h3, h4 { color: var(--d-ink) !important; }
  p, li { color: var(--d-ink-2) !important; }
  code {
    background: var(--d-bg-3) !important;
    border: 1px solid var(--d-border) !important;
    color: var(--d-warm-bright) !important;
  }
  /* Field-preview pills (button preview previews) */
  .preview-block {
    background: var(--d-bg-3) !important;
    border-color: rgba(212,182,115,0.45) !important;
  }
  .preview-block .pv-input {
    background: var(--d-bg-4) !important;
    border-color: var(--d-border) !important;
    color: var(--d-muted) !important;
  }
  .preview-block .pv-q {
    background: var(--d-bg-4) !important;
    border-color: var(--d-border) !important;
  }
  .preview-block .pv-q-text { color: var(--d-ink) !important; }
  .preview-block .pv-q-helper, .preview-block .pv-toggle, .preview-block .pv-sub { color: var(--d-muted) !important; }
  /* Inline color picker pill */
  .inline-color {
    background: var(--d-bg-3) !important;
    border-color: var(--d-border) !important;
    color: var(--d-muted) !important;
  }
  .inline-color:hover { border-color: var(--d-border-strong) !important; background: var(--d-bg-4) !important; }
  /* Sub-panel hint (hidden anyway) */
  /* Question block */
  .question-block { background: var(--d-bg-3) !important; }
</style>
</head>
<body>

<div id="gate" class="gate" style="display:none;">
  <div class="gate-bookmark">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
    <div>
      <strong>Bookmark this page.</strong>
      <span>This is your StokeReel dashboard — you'll come back here every time you change branding, edit questions, or review submissions.</span>
    </div>
  </div>
  <h1>Sign in to StokeReel</h1>
  <p class="sub">Your dashboard is where you customize your recorder, edit questions, watch submissions, and grab embed links — all in one place. Enter your admin password to get in.</p>
  <input type="password" id="pw" placeholder="Password" />
  <button onclick="login()">Sign in</button>
  <div id="gateErr" class="error" style="margin-top:12px; display:none;"></div>
  <div style="margin-top: 18px; text-align: center;">
    <a href="#" onclick="event.preventDefault(); document.getElementById('forgotModal').style.display='flex';" style="color: #6b6b6b; font-size: 13px; text-decoration: underline;">Forgot password?</a>
  </div>
</div>

<div id="forgotModal" style="display:none; position:fixed; inset:0; background:rgba(15,23,42,0.55); z-index:9999; align-items:flex-start; justify-content:center; padding:48px 16px; overflow-y:auto;">
  <div style="background:white; max-width:640px; width:100%; border-radius:16px; padding:32px 36px; box-shadow:0 24px 60px -12px rgba(15,23,42,0.35); position:relative; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;">
    <button onclick="document.getElementById('forgotModal').style.display='none';" style="position:absolute; top:14px; right:14px; background:transparent; border:0; color:#9a9385; font-size:22px; cursor:pointer; padding:4px 10px; border-radius:6px; box-shadow:none;">×</button>
    <h2 style="font-family: 'Fraunces', Georgia, serif; font-size:24px; font-weight:600; margin:0 0 6px; letter-spacing:-0.015em;">Reset your password</h2>
    <p style="margin:0 0 22px; color:#6b6b6b; font-size:14px; line-height:1.55;">We don't store your password anywhere we can recover it for you. To reset it, you'll delete the config file from your own Cloudflare R2 storage and run the setup wizard again. Takes about 2 minutes.</p>

    <ol style="margin:0; padding-left:22px; line-height:1.7; font-size:14px; color:#1a1a1a;">
      <li style="margin-bottom:10px;">Open your <a href="https://dash.cloudflare.com/?to=/:account/r2/overview" target="_blank" rel="noopener" style="color:#1a1a1a; font-weight:600;">Cloudflare R2 dashboard</a> in a new tab.</li>
      <li style="margin-bottom:10px;">Click on your bucket (probably named <code style="background:#faf7f2; padding:2px 6px; border-radius:4px; font-size:12.5px;">testimonials</code>).</li>
      <li style="margin-bottom:10px;">In the bucket's file list, navigate into the <code style="background:#faf7f2; padding:2px 6px; border-radius:4px; font-size:12.5px;">_system</code> folder.</li>
      <li style="margin-bottom:10px;">You'll see a single file: <code style="background:#faf7f2; padding:2px 6px; border-radius:4px; font-size:12.5px;">setup.json</code>. Click the <strong>⋯</strong> menu next to it and choose <strong>Delete</strong>.</li>
      <li style="margin-bottom:10px;">Confirm the deletion. <span style="color:#6b6b6b; font-size:13px;">(This only deletes your password and R2 connection settings. Your videos and form configurations stay safe.)</span></li>
      <li style="margin-bottom:10px;">Come back here and visit your StokeReel URL with <code style="background:#faf7f2; padding:2px 6px; border-radius:4px; font-size:12.5px;">/setup</code> on the end. The wizard will run again and let you set a new password.</li>
    </ol>

    <div style="margin-top: 22px; padding: 14px 16px; background: #fef9e7; border: 1px solid #f0e6c4; border-left: 3px solid #c9a961; border-radius: 8px; font-size: 13px; line-height: 1.6;">
      <strong>This time, type the password yourself.</strong> If your password manager (1Password, iCloud Keychain, Chrome, etc.) pops up offering to "suggest a strong password" — dismiss it. Pick a password you'll remember, then save it manually to your password manager after.
    </div>

    <div style="margin-top: 20px; display:flex; justify-content:flex-end; gap:8px;">
      <button onclick="document.getElementById('forgotModal').style.display='none';" class="secondary">Got it</button>
    </div>
  </div>
</div>

<div id="app" style="display:none;">
  <div class="app-shell">
  <div id="updateBanner" class="update-banner" style="display:none;">
    <span class="update-banner-icon">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15A9 9 0 1 1 19.65 8.36L23 11"/></svg>
    </span>
    <span class="update-banner-text">
      A newer version of StokeReel is available
      <span class="update-banner-versions">(<span id="updateBannerCurrent">v0.0.0</span> → <span id="updateBannerLatest">v0.0.0</span>)</span>
    </span>
    <button class="update-banner-btn" onclick="document.getElementById('updateModal').style.display='flex';">How to update</button>
    <button class="update-banner-dismiss" onclick="dismissUpdateBanner()" title="Dismiss until the next version">×</button>
  </div>

  <div id="updateModal" style="display:none; position:fixed; inset:0; background:rgba(15,23,42,0.55); z-index:9999; align-items:flex-start; justify-content:center; padding:48px 16px; overflow-y:auto;">
    <div style="background:white; max-width:680px; width:100%; border-radius:16px; padding:32px 36px; box-shadow:0 24px 60px -12px rgba(15,23,42,0.35); position:relative; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;">
      <button onclick="document.getElementById('updateModal').style.display='none';" style="position:absolute; top:14px; right:14px; background:transparent; border:0; color:#9a9385; font-size:22px; cursor:pointer; padding:4px 10px; border-radius:6px; box-shadow:none;">×</button>
      <h2 style="font-family: 'Fraunces', Georgia, serif; font-size:24px; font-weight:600; margin:0 0 6px; letter-spacing:-0.015em;">Update to the latest version</h2>
      <p style="margin:0 0 22px; color:#6b6b6b; font-size:14px; line-height:1.55;">Your install of StokeReel is on <strong id="updateModalCurrent">v0.0.0</strong>. The latest release is <strong id="updateModalLatest">v0.0.0</strong>. Updating takes about 2 minutes and won't touch your videos, submissions, or branding.</p>

      <h3 style="font-size:14px; font-weight:700; margin:0 0 10px; color:#1a1a1a;">Easiest way (recommended)</h3>
      <ol style="margin:0 0 22px; padding-left:22px; line-height:1.7; font-size:13.5px; color:#1a1a1a;">
        <li style="margin-bottom:8px;">Open your <a href="https://github.com/" target="_blank" rel="noopener" style="color:#1a1a1a; font-weight:600;">GitHub account</a> and go to your StokeReel repo (the one Cloudflare imported when you first deployed).</li>
        <li style="margin-bottom:8px;">Click the <strong>⋯</strong> menu near the top → <strong>Settings</strong> → scroll to the bottom → <strong>Delete this repository</strong>. Confirm.</li>
        <li style="margin-bottom:8px;">In Cloudflare, open <a href="https://dash.cloudflare.com/?to=/:account/workers-and-pages" target="_blank" rel="noopener" style="color:#1a1a1a; font-weight:600;">Workers &amp; Pages</a>, click your StokeReel project, then <strong>Settings → Delete project</strong>.</li>
        <li style="margin-bottom:8px;">Open your <a href="https://stokereel.com/welcome" target="_blank" rel="noopener" style="color:#1a1a1a; font-weight:600;">StokeReel welcome page</a> (the one with your purchase token) and click <strong>Deploy to Cloudflare</strong> again. This re-imports the latest version.</li>
        <li style="margin-bottom:8px;">Run the setup wizard at <code style="background:#faf7f2; padding:2px 6px; border-radius:4px; font-size:12.5px;">/setup</code> with the same R2 keys and admin password you used before. Your videos and saved configurations are still there because they live in R2 (which you didn't delete).</li>
      </ol>

      <details style="border-top:1px dashed #ede4cc; padding-top:14px;">
        <summary style="cursor:pointer; font-weight:600; color:#6b6b6b; font-size:13px;">Advanced: update via git (faster if you're comfortable with the terminal)</summary>
        <ol style="margin:10px 0 0; padding-left:22px; line-height:1.7; font-size:13px; color:#1a1a1a;">
          <li style="margin-bottom:6px;">Clone your existing GitHub repo locally: <code style="background:#faf7f2; padding:2px 6px; border-radius:4px; font-size:12px;">git clone &lt;your-repo-url&gt;</code></li>
          <li style="margin-bottom:6px;"><code style="background:#faf7f2; padding:2px 6px; border-radius:4px; font-size:12px;">cd</code> into it.</li>
          <li style="margin-bottom:6px;">Add the upstream source as a remote: <code style="background:#faf7f2; padding:2px 6px; border-radius:4px; font-size:12px;">git remote add upstream https://github.com/michaelrochin/wkr-bundle-x9k4.git</code></li>
          <li style="margin-bottom:6px;"><code style="background:#faf7f2; padding:2px 6px; border-radius:4px; font-size:12px;">git pull upstream main --allow-unrelated-histories</code></li>
          <li style="margin-bottom:6px;">Resolve any merge conflicts (usually none for a normal install).</li>
          <li style="margin-bottom:6px;"><code style="background:#faf7f2; padding:2px 6px; border-radius:4px; font-size:12px;">git push origin main</code> — Cloudflare auto-redeploys within ~1 minute.</li>
        </ol>
      </details>

      <div style="margin-top: 22px; display:flex; justify-content:flex-end; gap:8px;">
        <button onclick="dismissUpdateBanner(); document.getElementById('updateModal').style.display='none';" class="secondary">Remind me later</button>
      </div>
    </div>
  </div>

  <div class="app-header">
    <div class="brand-row">
      <div class="brand-mark">
        <svg width="32" height="32" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect width="64" height="64" rx="14" fill="#1a1a1a"/>
          <polygon points="24,16 24,48 52,32" fill="#c9a961"/>
        </svg>
        <div>
          <div class="brand-name">StokeReel</div>
          <div class="brand-tag" id="tabSub">Configure your funnels and review submissions</div>
        </div>
      </div>
      <div class="brand-actions">
        <div class="tabs">
          <button class="tab active" data-tab="branding" onclick="switchTab('branding')">Configure</button>
          <button class="tab" data-tab="submissions" onclick="switchTab('submissions')">Submissions</button>
        </div>
        <button onclick="logout()" class="ghost-btn">Sign out</button>
      </div>
    </div>

    <div class="workspace-bar" id="workspaceBar">
      <div class="ws-group">
        <label class="ws-label">Client</label>
        <div class="ws-select-wrap">
          <select id="clientName" class="ws-select"><option value="">— Pick a client —</option></select>
          <button class="ws-add" onclick="promptNewClient()" title="Add a new client">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New client
          </button>
        </div>
      </div>
      <div class="ws-divider"></div>
      <div class="ws-group">
        <label class="ws-label">Funnel</label>
        <div class="ws-select-wrap">
          <select id="courseName" class="ws-select"><option value="">All funnels (default)</option></select>
          <button class="ws-add" onclick="promptNewFunnel()" title="Add a new funnel override">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New funnel
          </button>
        </div>
      </div>
      <div class="ws-spacer"></div>
      <div id="scopeBadge" class="ws-scope-badge" style="display:none;"></div>
      <button onclick="deleteOverride()" id="deleteBtn" class="ws-delete" style="display:none;">Delete override</button>
    </div>
  </div>

  <div id="tab-branding" class="tab-panel active">
    <div style="display:none;">
      <div id="scopeBadgeLegacy"></div>
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
    <button class="sub-tab" data-subtab="emails" onclick="switchSubTab('emails')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
      Email templates
    </button>
    <button class="sub-tab" data-subtab="share" onclick="switchSubTab('share')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
      Share
    </button>
  </div>

  <div class="layout">
    <div class="panel">

      <div class="sub-panel active" data-sub="style">
      <div class="section">
        <h2>Logo</h2>
        <p class="help-text">Shows above the headline on intro and thank-you screens. PNG, JPG, SVG, or WebP. Max 2MB.</p>
        <div class="logo-row">
          <div id="logoPreview" class="logo-preview">No logo</div>
          <div class="logo-actions">
            <input type="file" id="logoFileInput" accept="image/png,image/jpeg,image/svg+xml,image/webp" style="display:none;">
            <button type="button" onclick="document.getElementById('logoFileInput').click()" class="secondary">Upload logo</button>
            <button type="button" onclick="removeLogo()" class="text-link-btn" id="logoRemoveBtn" style="display:none;">Remove</button>
            <button type="button" class="text-link-btn" onclick="toggleLogoUrl()">Use a URL instead</button>
          </div>
        </div>
        <div class="field" id="logoUrlField" style="display:none; margin-top:12px; margin-bottom:0;">
          <input type="text" data-key="logoUrl" placeholder="https://yoursite.com/logo.png">
        </div>
      </div>

      <div class="section">
        <h2>Quick-start templates</h2>
        <p class="help-text">Apply a preset look. You can customize anything after.</p>
        <div id="templatesGrid" class="templates-grid"></div>
      </div>

      <div class="section">
        <h2>Brand colors</h2>
        <p class="help-text">Click any swatch to pick a new color, or paste a hex value.</p>
        <div class="color-grid">
          <div class="color-cell">
            <label>Primary</label>
            <div class="color-input-row">
              <input type="color" data-key="brandColor" class="color-swatch">
              <input type="text" data-key="brandColor" class="color-hex">
            </div>
          </div>
          <div class="color-cell">
            <label>Primary hover</label>
            <div class="color-input-row">
              <input type="color" data-key="brandColorDark" class="color-swatch">
              <input type="text" data-key="brandColorDark" class="color-hex">
            </div>
          </div>
          <div class="color-cell">
            <label>Button text</label>
            <div class="color-input-row">
              <input type="color" data-key="buttonTextColor" class="color-swatch">
              <input type="text" data-key="buttonTextColor" class="color-hex">
            </div>
          </div>
          <div class="color-cell">
            <label>Background</label>
            <div class="color-input-row">
              <input type="color" data-key="backgroundColor" class="color-swatch">
              <input type="text" data-key="backgroundColor" class="color-hex">
            </div>
          </div>
          <div class="color-cell">
            <label>Body text</label>
            <div class="color-input-row">
              <input type="color" data-key="textColor" class="color-swatch">
              <input type="text" data-key="textColor" class="color-hex">
            </div>
          </div>
          <div class="color-cell">
            <label>Muted text</label>
            <div class="color-input-row">
              <input type="color" data-key="mutedTextColor" class="color-swatch">
              <input type="text" data-key="mutedTextColor" class="color-hex">
            </div>
          </div>
          <div class="color-cell">
            <label>Borders</label>
            <div class="color-input-row">
              <input type="color" data-key="borderColor" class="color-swatch">
              <input type="text" data-key="borderColor" class="color-hex">
            </div>
          </div>
          <div class="color-cell">
            <label>Record accent</label>
            <div class="color-input-row">
              <input type="color" data-key="errorColor" class="color-swatch">
              <input type="text" data-key="errorColor" class="color-hex">
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <h2>Heading font</h2>
        <p class="help-text">Google fonts auto-load on the live recorder. No setup needed.</p>
        <div class="field" style="margin-bottom:0;">
          <select data-key="headingFont" id="headingFontSelect" class="premium-select"></select>
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
      <div class="section">
        <h2>Button corners</h2>
        <p class="help-text">Pick the corner style for every button — Start, Next, Submit, Record, all of them.</p>
        <div class="shape-grid two-col" data-shape-target="buttonStyle" data-mirror="recordButtonShape">
          <button type="button" class="shape-card" data-shape-value="rounded" onclick="pickShape(this)">
            <div class="shape-demo shape-demo-pill">Record</div>
            <span>Curved corners</span>
          </button>
          <button type="button" class="shape-card" data-shape-value="sharp" onclick="pickShape(this)">
            <div class="shape-demo shape-demo-sharp">Record</div>
            <span>Sharp corners</span>
          </button>
        </div>
        <input type="hidden" data-key="buttonStyle">
        <input type="hidden" data-key="recordButtonShape">
      </div>

      <div class="section">
        <h2>Record button placement</h2>
        <p class="help-text">Where the big Record button sits on the question screen.</p>
        <div class="shape-grid two-col" data-shape-target="recordButtonPlacement">
          <button type="button" class="shape-card" data-shape-value="above-video" onclick="pickShape(this)">
            <div class="placement-demo">
              <div class="placement-line" style="width:80%;"></div>
              <div class="placement-line" style="width:60%;"></div>
              <div class="placement-btn"></div>
              <div class="placement-video"></div>
            </div>
            <span>Above the video</span>
          </button>
          <button type="button" class="shape-card" data-shape-value="below-video" onclick="pickShape(this)">
            <div class="placement-demo">
              <div class="placement-line" style="width:80%;"></div>
              <div class="placement-line" style="width:60%;"></div>
              <div class="placement-video"></div>
              <div class="placement-btn"></div>
            </div>
            <span>Below the video</span>
          </button>
        </div>
        <input type="hidden" data-key="recordButtonPlacement">
      </div>

      <div class="section">
        <h2>Button labels &amp; colors</h2>
        <p class="help-text">Customize what each button says. Click the swatch to recolor it on the fly.</p>
        <div class="field button-field"><label>Record button label</label>
          <input type="text" data-key="startRecordingLabel" placeholder="Record">
          <div class="button-row"><div class="field-preview" data-preview-for="startRecordingLabel"></div><label class="inline-color"><input type="color" data-key="errorColor"><span>Color</span></label></div>
        </div>
        <div class="field button-field"><label>Next-question button</label>
          <input type="text" data-key="nextQuestionLabel" placeholder="Next question →">
          <div class="button-row"><div class="field-preview" data-preview-for="nextQuestionLabel"></div><label class="inline-color"><input type="color" data-key="brandColor"><span>Color</span></label></div>
        </div>
        <div class="field button-field"><label>Done / review button (last question)</label>
          <input type="text" data-key="doneReviewLabel" placeholder="Done — review">
          <div class="button-row"><div class="field-preview" data-preview-for="doneReviewLabel"></div><label class="inline-color"><input type="color" data-key="textColor"><span>Color</span></label></div>
        </div>
        <div class="field button-field"><label>Start-over button (review screen)</label>
          <input type="text" data-key="restartLabel" placeholder="Start over">
          <div class="button-row"><div class="field-preview" data-preview-for="restartLabel"></div><label class="inline-color"><input type="color" data-key="borderColor"><span>Border</span></label></div>
        </div>
        <div class="field button-field"><label>Submit button (review screen)</label>
          <input type="text" data-key="submitLabel" placeholder="Looks good — submit">
          <div class="button-row"><div class="field-preview" data-preview-for="submitLabel"></div><label class="inline-color"><input type="color" data-key="brandColor"><span>Color</span></label></div>
        </div>
        <div class="field button-field"><label>Submit button (text-mode)</label>
          <input type="text" data-key="submitTextLabel" placeholder="Submit">
          <div class="button-row"><div class="field-preview" data-preview-for="submitTextLabel"></div><label class="inline-color"><input type="color" data-key="brandColor"><span>Color</span></label></div>
        </div>
        <div class="toggle-row">
          <div class="toggle-label">Show "Type instead" link
            <small>Lets people type their answer if they don't want to record.</small>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" data-key="showTypeInsteadLink">
            <span class="slider"></span>
          </label>
        </div>
        <div class="field"><label>"Type instead" link text</label>
          <input type="text" data-key="typeInsteadLabel" placeholder="Prefer to type instead? Click here.">
          <div class="field-preview" data-preview-for="typeInsteadLabel"></div>
        </div>
        <div class="toggle-row">
          <div class="toggle-label">Show "Switch back to video" link
            <small>Visible only after someone has switched to text mode.</small>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" data-key="showSwitchToVideoLink">
            <span class="slider"></span>
          </label>
        </div>
        <div class="field"><label>"Switch back to video" link text</label>
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
        <div class="toggle-row">
          <div class="toggle-label">Allow video recording
            <small>Shows the camera-based recording flow.</small>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" data-key="allowVideo" id="allowVideoBox">
            <span class="slider"></span>
          </label>
        </div>
        <div class="toggle-row">
          <div class="toggle-label">Allow typed responses
            <small>Lets people type instead. Uncheck to force video only.</small>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" data-key="allowText" id="allowTextBox">
            <span class="slider"></span>
          </label>
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

      <div class="sub-panel" data-sub="emails">
      <p class="sub-panel-hint">Send these to past customers to collect testimonials. Replace the <code>[BRACKETED]</code> fields with your specific program, gift, and voice.</p>

      <div class="section">
        <div class="section-eyebrow">Your recording URL</div>
        <h2>Use this link in every email</h2>
        <p class="help-text" style="margin: 0 0 12px;">Replace <code>[RECORDING PAGE URL]</code> in every email below with this:</p>
        <div class="share-input-row">
          <input id="emailsRecordingUrl" type="text" readonly placeholder="Pick a client to load your URL">
          <button onclick="copyShare('emailsRecordingUrl', this)" class="secondary">Copy</button>
        </div>
      </div>

      <div class="section">
        <div class="section-eyebrow">Cadence</div>
        <h2>5-day testimonial collection sequence</h2>
        <p class="help-text" style="margin: 0 0 16px;">Send Email 1 immediately, then Days 3 / 6 / 10 / 14. Each email below has a Copy button.</p>

        <div class="email-card">
          <div class="email-card-head">
            <span class="email-day">Email 1 · The Ask</span>
          </div>
          <div class="email-subject-line">Subject: a small favor (and something I'd like to give you)</div>
          <div class="email-body-line">Sent this to a handful of people who went through [PROGRAM NAME] with me.

I'm [OPENING IT AGAIN / LAUNCHING SOMETHING NEW / RUNNING THE NEXT ROUND] [TIMEFRAME, e.g. "next month"]. Before I do, I want to put real student stories on the page. Not testimonials. Stories. From the people who actually went through [THE PROGRAM] and came out the other side [SPECIFIC TRANSFORMATION].

Yours is one I'd love to have.

If you'll record a short video for me, I want to give you something in return. [DESCRIBE THE GIFT.]

Yours, on me, as a thank you.

I built a little page that makes recording the video easy. You click the link, it walks you through a few short questions, and you record your answer to each one right there on your phone or your computer. No app to download. No video to upload. Nothing to email me.

Takes about 60 seconds.

[CTA TEXT, e.g. "Record your story →"]
[RECORDING PAGE URL]

A few things, in case you're worried:

You don't need to look polished. Hold your phone in front of you, prop it on a stack of books if your arm gets tired, and talk like you're [TELLING A FRIEND OVER COFFEE].

You can re-record if you flub it. There's a button.

People who hate being on camera do this beautifully. The thing that lands isn't polish. It's you, telling the truth.

Once you've recorded, I'll send the [GIFT NAME] over within a day or two.

[SIGN-OFF],
[YOUR NAME]

P.S. If you're worried your story isn't impressive enough — that's the story I want most. The quiet wins. [SPECIFIC SMALL-WIN EXAMPLE]. That's the truth other [YOUR AUDIENCE] need to hear.</div>
          <button class="copy-btn-pro" onclick="copyEmailFromPanel(this)">Copy email</button>
        </div>

        <div class="email-card">
          <div class="email-card-head">
            <span class="email-day">Email 2 · The Nudge · Day 3</span>
          </div>
          <div class="email-subject-line">Subject: in case you missed it</div>
          <div class="email-body-line">Quick one.

Sent you something a few days ago about recording a short video for me. Sometimes my emails get buried, so I wanted to make sure it didn't slip past you.

The short version: I'm putting student stories on the page for [THE NEXT THING]. If you record a quick one — three questions, prompted on your phone, takes a minute — I'll send you [GIFT NAME] as a thank you.

Here's the link →
[RECORDING PAGE URL]

The page handles everything. No prep, no upload, no editing.

If you'd rather not, all good. I just didn't want you to miss it.

[SIGN-OFF],
[YOUR NAME]</div>
          <button class="copy-btn-pro" onclick="copyEmailFromPanel(this)">Copy email</button>
        </div>

        <div class="email-card">
          <div class="email-card-head">
            <span class="email-day">Email 3 · The Story · Day 6</span>
          </div>
          <div class="email-subject-line">Subject: [SHORT, INTRIGUING SUBJECT REFERENCING A STORY]</div>
          <div class="email-body-line">[OPENING SCENE — 2-4 short paragraphs. A specific moment from your life where someone or something made you confront the exact problem your program solves. Use real names, real places, real dialogue if you have it. Short sentences. One-line paragraphs.]

[THE LESSON LINE — one sentence stating what the moment taught you, written like a punch.]

[CONNECT TO YOUR PROGRAM — one sentence: "That [moment] is the whole reason [PROGRAM NAME] exists."]

I'm telling you this because I'm asking the people who went through [THE PROGRAM] to share their version of that moment. The thing they couldn't do before, that they can do now. [THE TRANSFORMATION.]

If you have one — and I'd bet you do — would you tell me about it on camera?

[CTA →]
[RECORDING PAGE URL]

The page walks you through three short prompts on your phone or computer. About a minute. And as a thank you, I'll send you [GIFT NAME].

[SIGN-OFF],
[YOUR NAME]

P.S. If your moment was a small one — a tiny shift, not a transformation — that's still the story I want. The small ones are usually the most honest.</div>
          <button class="copy-btn-pro" onclick="copyEmailFromPanel(this)">Copy email</button>
        </div>

        <div class="email-card">
          <div class="email-card-head">
            <span class="email-day">Email 4 · The Honest One · Day 10</span>
          </div>
          <div class="email-subject-line">Subject: the part that's hard to ask for</div>
          <div class="email-body-line">I've been sitting on this email for a few days.

Asking for testimonials feels strange to me. I don't love doing it. Part of me would rather just [DO YOUR WORK / OPEN THE THING / LET THE WORK SPEAK].

But here's the thing.

When someone is on the fence about [DOING THE PROGRAM] — [SPECIFIC STAKES] — what moves them isn't me telling them it works. It's [SOMEONE LIKE THEM], [SPECIFIC IMAGE], saying "I was where you are, and now I'm not."

That's the only thing that actually moves people. I've seen it.

So if you've gotten something out of [THE PROGRAM], and you have a minute, would you record a short one for me?

Here's the link →
[RECORDING PAGE URL]

Three short prompts on the screen. About a minute. [GIFT NAME] is yours when you're done.

And if you'd rather not — really, truly, no pressure. The fact that you were in the room is enough.

[SIGN-OFF],
[YOUR NAME]</div>
          <button class="copy-btn-pro" onclick="copyEmailFromPanel(this)">Copy email</button>
        </div>

        <div class="email-card">
          <div class="email-card-head">
            <span class="email-day">Email 5 · Last Call · Day 14</span>
          </div>
          <div class="email-subject-line">Subject: closing the window</div>
          <div class="email-body-line">Last note on this, then I'll stop asking.

I'm [WRAPPING UP THE PAGE / FINALIZING THE LAUNCH] [SPECIFIC TIMEFRAME, e.g. "this weekend"]. After that, I'm heads-down on [THE NEXT THING] and I won't open this back up.

If you've been meaning to record one and just haven't sat down to do it — this is the moment.

[CTA →]
[RECORDING PAGE URL]

A minute on your phone. Three prompts. [GIFT NAME] in your inbox when you're done.

If you don't get to it, I understand. Thank you for being part of [THE PROGRAM] either way. Genuinely.

[SIGN-OFF],
[YOUR NAME]

P.S. If you started recording one and got self-conscious and closed the tab — happens to almost everyone. Open it back up. The first ten seconds are the hardest. After that you forget the camera is there.</div>
          <button class="copy-btn-pro" onclick="copyEmailFromPanel(this)">Copy email</button>
        </div>
      </div>

      <div class="section">
        <div class="section-eyebrow">Reference</div>
        <h2>Fields you'll fill in once</h2>
        <p class="help-text" style="margin: 0 0 12px;">Same fields appear across the sequence. Fill them in once mentally, replace consistently.</p>
        <ul class="reference-list">
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

      <div class="wizard-nav"></div>
      </div><!-- /sub-panel emails -->

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

    <div class="rail">
      <div class="device-tabs" role="tablist">
        <button class="device-tab active" data-device="desktop" onclick="switchDevice('desktop')" title="Desktop">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          Desktop
        </button>
        <button class="device-tab" data-device="tablet" onclick="switchDevice('tablet')" title="Tablet">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
          Tablet
        </button>
        <button class="device-tab" data-device="mobile" onclick="switchDevice('mobile')" title="Mobile">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
          Mobile
        </button>
      </div>
      <div class="live-preview-panel" id="livePreviewPanel">
        <div class="live-preview-header">Live preview · updates as you type</div>
        <div class="device-frame-wrap device-desktop" id="deviceFrameWrap">
          <iframe id="livePreviewFrame" class="live-preview-iframe" title="Live recorder preview" allow="camera; microphone" onload="applyDeviceScale()"></iframe>
        </div>
        <div class="live-preview-empty" id="livePreviewEmpty" style="display:none;">Pick a client to see the live preview here.</div>
      </div>
      <div class="rail-tip" id="railTip">
        <div class="rail-tip-eyebrow">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          <span>Tip</span>
        </div>
        <p class="rail-tip-body" id="railTipBody">Pick a client above to start customizing. Everything you change here updates the live preview instantly — nothing is saved until you hit <strong>Save changes</strong> or <strong>Save &amp; next</strong>.</p>
      </div>
    </div>
  </div>
  </div><!-- /tab-panel branding -->

  <div id="tab-submissions" class="tab-panel">
    <div class="subs-toolbar">
      <div class="subs-count-wrap">
        <span id="subsCount" class="subs-count">—</span>
      </div>
      <div class="subs-actions">
        <select id="subsCourseFilter" class="ws-select">
          <option value="">All funnels</option>
        </select>
        <button onclick="loadSubmissions()" class="subs-btn-ghost" title="Refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          Refresh
        </button>
        <button onclick="exportCsv()" class="subs-btn-primary">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export CSV
        </button>
      </div>
    </div>
    <div class="subs-content">
      <div id="submissionsGrid" class="submissions-grid"></div>
    </div>
  </div>
  </div><!-- /app-shell -->
</div>

<div id="toast" class="toast"></div>

<script>
const STORAGE_KEY = "vt_admin_pw";
const STORAGE_CLIENT = "vt_config_client";
const STORAGE_COURSE = "vt_config_course";
const STOKEREEL_VERSION = "{{STOKEREEL_VERSION}}";
const UPSTREAM_VERSION_URL = "{{UPSTREAM_VERSION_URL}}";
const UPDATE_DISMISS_KEY = "vt_dismissed_update_for";

// Compare two semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
function semverCompare(a, b) {
  const pa = String(a || "0").split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function checkForUpdate() {
  // If user already dismissed this exact upstream version, skip the banner.
  let upstream;
  try {
    const res = await fetch(UPSTREAM_VERSION_URL, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    upstream = data && data.version;
  } catch { return; }
  if (!upstream) return;
  if (semverCompare(upstream, STOKEREEL_VERSION) <= 0) return;
  const dismissed = localStorage.getItem(UPDATE_DISMISS_KEY);
  if (dismissed === upstream) return;
  // Show the banner
  const banner = document.getElementById("updateBanner");
  document.getElementById("updateBannerCurrent").textContent = "v" + STOKEREEL_VERSION;
  document.getElementById("updateBannerLatest").textContent = "v" + upstream;
  document.getElementById("updateModalCurrent").textContent = "v" + STOKEREEL_VERSION;
  document.getElementById("updateModalLatest").textContent = "v" + upstream;
  banner.dataset.upstream = upstream;
  banner.style.display = "flex";
}

function dismissUpdateBanner() {
  const banner = document.getElementById("updateBanner");
  const upstream = banner && banner.dataset.upstream;
  if (upstream) localStorage.setItem(UPDATE_DISMISS_KEY, upstream);
  if (banner) banner.style.display = "none";
}
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

function toggleLogoUrl() {
  const f = document.getElementById("logoUrlField");
  if (!f) return;
  f.style.display = f.style.display === "none" ? "block" : "none";
  if (f.style.display === "block") {
    const inp = f.querySelector("input");
    if (inp) inp.focus();
  }
}

function pickShape(btn) {
  const grid = btn.closest(".shape-grid");
  if (!grid) return;
  const targetKey = grid.getAttribute("data-shape-target");
  const mirrorKey = grid.getAttribute("data-mirror");
  const value = btn.getAttribute("data-shape-value");
  // Toggle active class on cards
  grid.querySelectorAll(".shape-card").forEach(c => c.classList.toggle("active", c === btn));
  // Sync the hidden input(s) that hold this config value, then trigger the
  // existing input listener so refreshPreview() runs and the iframe updates.
  const keys = mirrorKey ? [targetKey, mirrorKey] : [targetKey];
  keys.forEach(k => {
    const hidden = document.querySelector('input[type="hidden"][data-key="' + k + '"]');
    if (hidden) {
      hidden.value = value;
      hidden.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}

// Native dimensions per device (must match CSS above; values are visual size including border)
const DEVICE_DIMS = {
  desktop: { w: 1280, h: 800 },
  tablet: { w: 768, h: 1024 },
  mobile: { w: 390, h: 844 }
};
const DEVICE_PAD = 16; // breathing room around the device chrome inside the wrap
let currentDevice = "desktop";

function applyDeviceScale() {
  const wrap = document.getElementById("deviceFrameWrap");
  const iframe = document.getElementById("livePreviewFrame");
  if (!wrap || !iframe) return;
  // Desktop fills the rail natively — clear any leftover transform from tablet/mobile.
  if (currentDevice === "desktop") {
    iframe.style.transform = "";
    return;
  }
  const dims = DEVICE_DIMS[currentDevice];
  if (!dims) return;
  const availW = wrap.clientWidth - DEVICE_PAD * 2;
  const availH = wrap.clientHeight - DEVICE_PAD * 2;
  if (availW <= 0 || availH <= 0) return;
  const scale = Math.min(availW / dims.w, availH / dims.h, 1);
  const scaledW = dims.w * scale;
  const scaledH = dims.h * scale;
  const offsetX = DEVICE_PAD + Math.max(0, (availW - scaledW) / 2);
  const offsetY = DEVICE_PAD + Math.max(0, (availH - scaledH) / 2);
  iframe.style.transform = "translate(" + offsetX + "px, " + offsetY + "px) scale(" + scale + ")";
}

function switchDevice(device) {
  if (!DEVICE_DIMS[device]) return;
  currentDevice = device;
  document.querySelectorAll(".device-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.device === device);
  });
  const wrap = document.getElementById("deviceFrameWrap");
  if (!wrap) return;
  wrap.classList.remove("device-desktop", "device-tablet", "device-mobile");
  wrap.classList.add("device-" + device);
  // Wait for the new size CSS to apply before measuring + scaling.
  requestAnimationFrame(() => requestAnimationFrame(applyDeviceScale));
}

window.addEventListener("resize", () => applyDeviceScale());
// In case the rail is laid out after first paint, re-scale once on load.
window.addEventListener("load", () => applyDeviceScale());
// Re-scale whenever the wrap's size changes — handles login gate -> app reveal,
// window resize, and any layout shift that would otherwise leave the iframe stuck
// at a wrong scale (e.g. measured at 0px before the panel was visible).
if (typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(() => applyDeviceScale());
  document.addEventListener("DOMContentLoaded", () => {
    const wrap = document.getElementById("deviceFrameWrap");
    if (wrap) ro.observe(wrap);
  });
}

function syncShapeCards() {
  document.querySelectorAll(".shape-grid").forEach(grid => {
    const key = grid.getAttribute("data-shape-target");
    const hidden = document.querySelector('input[type="hidden"][data-key="' + key + '"]');
    const current = hidden ? hidden.value : "";
    grid.querySelectorAll(".shape-card").forEach(c => {
      c.classList.toggle("active", c.getAttribute("data-shape-value") === current);
    });
  });
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
function showApp() {
  document.getElementById("gate").style.display = "none";
  document.getElementById("app").style.display = "block";
  // Fire-and-forget — checks upstream version and reveals the update banner if needed.
  try { checkForUpdate(); } catch {}
}

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
  sel.innerHTML = opts.join("");
}

function populateFunnelSelect(funnels, selected) {
  const sel = document.getElementById("courseName");
  const wanted = selected || sel.value || "";
  const opts = ['<option value="">All funnels (default)</option>'];
  for (const f of funnels) {
    opts.push('<option value="' + escapeAttr(f) + '"' + (f === wanted ? ' selected' : '') + '>' + escapeHtml(f) + '</option>');
  }
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

function promptNewClient() {
  const sel = document.getElementById("clientName");
  const raw = prompt("Name this client (e.g. \\"lotilabs\\" or \\"acme-co\\"):");
  const slug = slugify(raw || "");
  if (!slug) return;
  const existing = sel.querySelector(\`option[value="\${slug}"]\`);
  if (!existing) {
    const opt = document.createElement("option");
    opt.value = slug;
    opt.textContent = slug;
    const newOpt = sel.querySelector(\`option[value="\${NEW_OPTION}"]\`);
    if (newOpt) sel.insertBefore(opt, newOpt);
    else sel.appendChild(opt);
  }
  sel.value = slug;
  handleClientChange();
}

function promptNewFunnel() {
  const clientSel = document.getElementById("clientName");
  if (!clientSel.value || clientSel.value === NEW_OPTION) {
    toast("Pick a client first.");
    return;
  }
  const sel = document.getElementById("courseName");
  const raw = prompt("Name this funnel (e.g. \\"play-what-you-hear\\" or \\"black-friday-2026\\"):");
  const slug = slugify(raw || "");
  if (!slug) return;
  const existing = sel.querySelector(\`option[value="\${slug}"]\`);
  if (!existing) {
    const opt = document.createElement("option");
    opt.value = slug;
    opt.textContent = slug;
    const newOpt = sel.querySelector(\`option[value="\${NEW_OPTION}"]\`);
    if (newOpt) sel.insertBefore(opt, newOpt);
    else sel.appendChild(opt);
  }
  sel.value = slug;
  handleFunnelChange();
}

async function handleClientChange() {
  const sel = document.getElementById("clientName");
  if (sel.value === NEW_OPTION) {
    const raw = prompt("Name this client (e.g. \\"lotilabs\\" or \\"acme-co\\"):");
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
  await refreshFunnelList(sel.value, "");
  persistSelection();
  // Auto-load the newly selected client's saved settings into the form so
  // the user doesn't have to refresh to see them.
  await loadConfig();
}

async function handleFunnelChange() {
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
  persistSelection();
  // Auto-load the funnel's override (or fall back to brand-wide) so the form
  // reflects what's actually saved for this funnel without needing a refresh.
  await loadConfig();
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
  if (!client) {
    box.style.display = "none";
    const emailsInputEmpty = document.getElementById("emailsRecordingUrl");
    if (emailsInputEmpty) emailsInputEmpty.value = "";
    return;
  }
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
  // Mirror this URL into the email-templates tab too
  const emailsInput = document.getElementById("emailsRecordingUrl");
  if (emailsInput) emailsInput.value = url;
  box.style.display = "block";
  // Auto-load (or create) the short link for this funnel
  loadShortLink();
}

async function copyEmailFromPanel(btn) {
  const card = btn.closest(".email-card");
  if (!card) return;
  const subjEl = card.querySelector(".email-subject-line");
  const bodyEl = card.querySelector(".email-body-line");
  const subject = subjEl ? subjEl.textContent.trim() : "";
  const body = bodyEl ? bodyEl.textContent : "";
  // Replace [RECORDING PAGE URL] with the user's actual URL if present
  const urlEl = document.getElementById("emailsRecordingUrl");
  const recordingUrl = urlEl && urlEl.value ? urlEl.value : "[RECORDING PAGE URL]";
  const filledBody = body.split("[RECORDING PAGE URL]").join(recordingUrl);
  const text = subject + "\\n\\n" + filledBody;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const original = btn.textContent;
  btn.textContent = "Copied!";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove("copied");
  }, 1500);
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
  // Reset any inline styles that may have been set previously
  badge.removeAttribute("style");
  badge.classList.remove("scope-brand", "scope-funnel", "scope-new");
  let dotColor, label, cls;
  if (course) {
    if (currentInherited) {
      dotColor = "#d4a017"; label = "New override · " + course; cls = "scope-new";
      deleteBtn.style.display = "none";
    } else {
      dotColor = "#2563eb"; label = "Funnel · " + course; cls = "scope-funnel";
      deleteBtn.style.display = "inline-block";
    }
  } else {
    dotColor = "#16a34a"; label = "Brand-wide"; cls = "scope-brand";
    deleteBtn.style.display = "none";
  }
  badge.classList.add(cls);
  badge.innerHTML =
    '<span class="ws-scope-dot" style="background:' + dotColor + ';"></span>' + escapeHtml(label);
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
  // Color pickers + paired text inputs share the same data-key.
  // ALWAYS overwrite so switching clients clears stale values from the
  // previously-loaded client. If the new config doesn't have a value, blank
  // the field (the recorder applies DEFAULTS for empty strings).
  document.querySelectorAll("[data-key]").forEach(el => {
    const key = el.getAttribute("data-key");
    if (key === "questions") return;
    if (el.type === "checkbox") {
      el.checked = config[key] !== false; // default true if undefined
    } else {
      el.value = config[key] !== undefined && config[key] !== null ? config[key] : "";
    }
  });

  // Wire up paired color/hex inputs and live updates — but only ONCE.
  // Without this guard, switching clients re-attaches a listener every time
  // and a single keystroke fires N stacked refreshPreview() calls.
  if (!window.__vtInputListenersAttached) {
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
    window.__vtInputListenersAttached = true;
  }

  if (!currentConfig.questions || !currentConfig.questions.length) {
    currentConfig.questions = [{ text: "", helper: "" }];
  }
  renderQuestions();
  refreshLogoPreview();
  renderCustomDomainCard();
  syncShapeCards();
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

const SUB_TAB_ORDER = ["style", "welcome", "questions", "thankyou", "buttons", "settings", "emails", "share"];
const SUB_TAB_LABELS = {
  style: "Style",
  welcome: "Welcome message",
  questions: "Questions",
  thankyou: "Thank-you message",
  buttons: "Buttons",
  settings: "Settings",
  emails: "Email templates",
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
  emails: "intro",
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

const RAIL_TIPS = {
  style: "Use a quick-start template if you're in a hurry. The colors and font you set here apply across welcome, questions, and thank-you screens.",
  welcome: "Keep it short. Two lines max. The recording starts in 30 seconds, so don't make people read for that long.",
  questions: "3 questions is the sweet spot. Each is a separate take, so people can re-record one without redoing all of them.",
  thankyou: "Use the gift link button to deliver the bonus you promised in your email. People expect their reward immediately after submitting.",
  buttons: "Defaults are tested. Only change if you have a strong reason — like a different language or your brand voice is unusually casual.",
  settings: "Most people leave these alone. The webhook is for power users sending submissions to Slack or Zapier.",
  emails: "Send Email 1 immediately, then space the rest by Day 3, 6, 10, 14. The bracketed fields are the only parts you fill in.",
  share: "The iframe embed is what 90% of people should use. It puts the recorder on YOUR domain — no DNS work, no cookie/cache headaches."
};
function switchSubTab(name) {
  document.querySelectorAll(".sub-tab").forEach(t => t.classList.toggle("active", t.dataset.subtab === name));
  document.querySelectorAll(".sub-panel").forEach(p => p.classList.toggle("active", p.dataset.sub === name));
  renderWizardNav(name);
  // Share + Emails tabs both display the recording URL — refresh on entry
  if (name === "share" || name === "emails") updateShareBox();
  // Tell the live preview iframe which screen to show (welcome/question/thank-you)
  pushPreviewStep(SUB_TAB_TO_PREVIEW_STEP[name] || "intro");
  // Update the contextual tip in the right rail
  const tipBody = document.getElementById("railTipBody");
  if (tipBody && RAIL_TIPS[name]) tipBody.textContent = RAIL_TIPS[name];
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
      ? '<button data-feature-key="' + escapeAttr(item.key) + '" data-feature-client="' + escapeAttr(item.client || "") + '" data-feature-state="' + (isFeatured ? "1" : "0") + '" class="feature-toggle' + (isFeatured ? ' is-featured' : '') + '">' + (isFeatured ? "★ Featured on intro" : "☆ Feature on intro") + '</button>'
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
    <div class="help">You'll use this password to sign into your dashboard. After this setup wizard finishes, you'll be sent there automatically. To come back later, visit your StokeReel URL with <code>/config</code> on the end (the same URL you're on right now, just with <code>/config</code> instead of <code>/setup</code>).</div>
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
      Permission: <code>Object Read &amp; Write</code>. After creating, Cloudflare shows you both keys on the <strong>same page, one right under the other</strong> — copy them into the fields below.
    </div>
    <div class="field">
      <label>Access Key ID</label>
      <input type="text" id="r2AccessKeyId" placeholder="e.g. 9b64b05362ee5e0711fd592d3c617e26" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other">
    </div>
    <div class="field">
      <label>Secret Access Key</label>
      <div class="help" style="margin-bottom: 6px; padding: 10px 12px; background: #fef9e7; border: 1px solid #f0e6c4; border-left: 3px solid #c9a961; border-radius: 6px; font-size: 13px;">
        <strong>⚠ Don't let your password manager create a password here.</strong> If 1Password / iCloud Keychain / Chrome / etc. pops up offering to "suggest a strong password," dismiss it. The Secret Access Key is the one Cloudflare gave you — paste that exact value, don't generate a new one. Look for it on the same page as your Access Key ID above.
      </div>
      <input type="password" id="r2SecretAccessKey" placeholder="Paste the Secret Access Key from Cloudflare" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other">
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

  <h2 style="margin-top: 0;">Setup guide — about 15 minutes total</h2>
  <p style="color: var(--muted); margin: 0 0 24px;">Work through these in order. Don't skip ahead — each step assumes the one before it is done.</p>

  <div class="card">
    <span class="step-num">1</span>
    <h3>Section 1 — Create your free Cloudflare account</h3>
    <p>Cloudflare is the infrastructure company that hosts your videos and runs the StokeReel app. We are not Cloudflare and have no affiliation with them — you'll have your own account that you fully own.</p>
    <ol>
      <li>Open <a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener">dash.cloudflare.com/sign-up</a></li>
      <li>Enter your email and pick a password</li>
      <li>Verify your email when their confirmation link arrives</li>
      <li>Skip any "add a website" prompts — you don't need to add a domain</li>
    </ol>
    <p style="font-size: 13px; color: var(--muted);"><strong>Cost so far:</strong> $0. No credit card required to start.</p>
  </div>

  <div class="card">
    <span class="step-num">2</span>
    <h3>Section 2 — Deploy StokeReel to your Cloudflare account</h3>
    <p>One click below. Cloudflare automatically creates the Worker (the app) and R2 bucket (the video storage) inside your account.</p>
    <a href="{{DEPLOY_URL}}" class="btn" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true"><path d="M12 2L2 19h20L12 2zm0 4l7.53 13H4.47L12 6z"/></svg>
      Deploy to Cloudflare
    </a>
    <ol style="margin-top: 16px;">
      <li>Click the <strong>Deploy to Cloudflare</strong> button above</li>
      <li>Sign in to Cloudflare if prompted (or it'll use the session from section 1)</li>
      <li><strong>Heads up — at the top of the page, Cloudflare will show an "Upgrade now!" banner that says "testimonials uses R2 which is only available with an R2 subscription."</strong> Click <strong>Upgrade now!</strong>. You're being asked to enable R2 (the video storage), not buying a paid SaaS plan. R2 has a generous free tier and won't charge you anything until you cross it. <em>(See the cost note below.)</em></li>
      <li>Cloudflare will ask for a credit card to enable R2. Enter it. Cloudflare requires it on file but doesn't charge it unless you exceed the free tier.</li>
      <li><strong>After R2 is enabled, come back to this page and click the Deploy to Cloudflare button again.</strong> The deploy form will now load without the upgrade prompt blocking you.</li>
      <li>Now fill in the deploy form:
        <ol style="margin-top: 6px;">
          <li><strong>Git account</strong> — connect your GitHub account (Cloudflare will prompt you to authorize). If you don't have one, create a free GitHub account at <a href="https://github.com/signup" target="_blank" rel="noopener">github.com/signup</a> first, then come back.</li>
          <li><strong>Create private Git repository</strong> — <strong>check this box.</strong> This keeps your copy of the StokeReel code private to your GitHub account so it isn't searchable by other people on the public internet.</li>
          <li><strong>Project name</strong> — leave it as <code>testimonials</code> (or change to whatever you want).</li>
          <li><strong>Select R2 bucket</strong> — choose <strong>+ Create new</strong>.</li>
          <li><strong>Name your R2 Bucket</strong> — type <code>testimonials</code> (this MUST match the project name above to avoid headaches).</li>
          <li><strong>Location hint</strong> — pick whichever region is closest to most of your customers (e.g. North America, Europe). Not critical — it just affects upload speed slightly.</li>
          <li><strong>Build command</strong> — leave blank.</li>
          <li><strong>Builds for non-production branches</strong> — leave it checked (default). Harmless if you don't push code; useful if you ever update.</li>
          <li>Any other "Optional" / "Advanced" fields — leave at their defaults.</li>
          <li>Scroll down and click <strong>Create and deploy</strong>.</li>
        </ol>
      </li>
      <li>Cloudflare provisions the Worker + R2 bucket. Takes about 60 seconds.</li>
      <li>When it finishes, copy the URL it gives you. It'll look like <code>https://testimonials.&lt;your-subdomain&gt;.workers.dev</code></li>
    </ol>
    <div style="margin-top: 16px; padding: 14px 16px; background: var(--cream); border: 1px solid var(--border); border-left: 3px solid var(--warm); border-radius: 8px; font-size: 14px; line-height: 1.6;">
      <strong>What R2 actually costs you</strong><br>
      Cloudflare's free tier covers <strong>10 GB of storage and 1M+ requests per month</strong> — enough for roughly <strong>1,000 testimonial videos</strong> at zero dollars. Past the free tier, storage is <strong>$0.015 per GB per month</strong>. In real numbers:
      <ul style="margin: 8px 0 0; padding-left: 20px;">
        <li>Up to ~1,000 testimonials → <strong>$0/month</strong></li>
        <li>~5,000 testimonials → about <strong>$0.60/month</strong></li>
        <li>~10,000 testimonials → about <strong>$1.50/month</strong></li>
      </ul>
      No "subscription" in the SaaS sense — you only pay for what you actually use, and the free tier is enough for most people indefinitely.
    </div>
  </div>

  <div class="card">
    <span class="step-num">3</span>
    <h3>Section 3 — Get your R2 storage credentials</h3>
    <p>StokeReel needs read/write access to the R2 bucket Cloudflare just created. You'll generate an API token and copy three values.</p>
    <ol>
      <li>In a new tab, open <a href="https://dash.cloudflare.com/?to=/:account/r2/api-tokens" target="_blank" rel="noopener">your R2 API Tokens page</a></li>
      <li>On the page, click the blue <strong>Create Account API token</strong> button at the top right. (There's another button further down called "Create User API token" — ignore that one. You want the top one.)</li>
      <li>Token name: <code>stokereel</code> (anything works)</li>
      <li>Permissions: <strong>Object Read &amp; Write</strong></li>
      <li>Specify bucket: pick the one you just created in section 2 (called <code>testimonials</code>, or whatever you named it).</li>
      <li>Leave <strong>TTL</strong> on its default of "Forever". Leave any other optional fields (IP address filtering, etc.) at their defaults too.</li>
      <li>Click <strong>Create Account API token</strong> at the bottom. Cloudflare shows you the token values <em>once</em> — copy them immediately into a notes app, you won't see them again.</li>
      <li>Note down all three values:
        <ol style="margin-top: 6px;">
          <li><strong>Access Key ID</strong> (shown right after creation)</li>
          <li><strong>Secret Access Key</strong> (shown right after creation)</li>
          <li><strong>Account ID</strong> — visible in the URL bar of the Cloudflare dashboard, right after <code>dash.cloudflare.com/</code> (it's a long hex string)</li>
        </ol>
      </li>
    </ol>
  </div>

  <div class="card">
    <span class="step-num">4</span>
    <h3>Section 4 — Run the StokeReel setup wizard</h3>
    <p>This connects your StokeReel app to the storage you just authorized. Takes about 2 minutes.</p>
    <ol>
      <li>First, find your StokeReel URL. If the deploy success screen from section 2 is still open, the URL is shown right there — copy it. If you closed it:
        <ol style="margin-top: 6px;">
          <li>Open <a href="https://dash.cloudflare.com/?to=/:account/workers-and-pages" target="_blank" rel="noopener">your Workers &amp; Pages dashboard</a></li>
          <li>You'll see your project listed. The URL underneath the project name is your StokeReel URL — looks like this:</li>
        </ol>
        <div style="margin: 14px 0 6px; padding: 18px 20px; background: #f6f7f9; border: 1px solid #e2e6ec; border-radius: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px;">
          <div style="display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 700; color: #1a1a1a; margin-bottom: 14px;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            Workers &amp; Pages
          </div>
          <div style="background: white; border: 1px solid #e2e6ec; border-radius: 10px; padding: 14px 16px; display: flex; align-items: center; gap: 14px; position: relative;">
            <div style="width: 32px; height: 32px; border-radius: 8px; background: #eef3ff; color: #2563eb; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            </div>
            <div style="flex: 1; min-width: 0;">
              <div style="font-weight: 700; color: #1a1a1a; font-size: 14px;">testimonials</div>
              <div style="position: relative; display: inline-block; margin-top: 2px;">
                <span style="display: inline-block; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 13px; color: #1a1a1a; background: #fffbe8; border: 1px solid #f0e6c4; padding: 3px 8px; border-radius: 6px;">testimonials.&lt;your-subdomain&gt;.workers.dev</span>
                <div style="position: absolute; left: calc(100% + 12px); top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 6px; white-space: nowrap;">
                  <svg width="22" height="14" viewBox="0 0 22 14" fill="none" aria-hidden="true">
                    <path d="M0 7 H17 M12 2 L17 7 L12 12" stroke="#c9a961" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 12px; font-weight: 700; color: #8a6f30; background: #fbf6e8; border: 1px solid #ecdfb6; padding: 4px 10px; border-radius: 999px;">This whole string is your URL</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <p style="font-size: 13px; color: var(--muted); margin: 4px 0 0;">Copy that URL — you'll need it for the next step.</p>
      </li>
      <li>In your browser, go to that URL and add <code>/setup</code> on the end. Example: <code>https://testimonials.<em>jane-doe</em>.workers.dev/setup</code></li>
      <li>Paste your <strong>Account ID</strong>, <strong>Access Key ID</strong>, and <strong>Secret Access Key</strong> from section 3 step 8</li>
      <li>Set an <strong>admin password</strong> — this is what you'll use to log into your dashboard. Make it strong.</li>
      <li>Click <strong>Save and continue</strong></li>
      <li>The wizard verifies the connection and redirects you to your dashboard</li>
    </ol>
  </div>

  <div class="card">
    <span class="step-num">5</span>
    <h3>Section 5 — Set up your first form</h3>
    <p>Now you'll create the actual recorder page your customers will use. Everything is in your dashboard.</p>
    <ol>
      <li>You should already be on your dashboard at <code>https://&lt;your-url&gt;/config</code> after section 4. If not, visit it and sign in with the password you just set.</li>
      <li>Click <strong>+ New client</strong> at the top. Type a slug like <code>my-business</code> or <code>acme</code> — this becomes the folder your testimonials live in.</li>
      <li>Walk through the eight tabs in order, hitting <strong>Save &amp; next</strong> at the bottom of each:
        <ol style="margin-top: 6px;">
          <li><strong>Style</strong> — pick a quick-start template, or set logo + colors + heading font</li>
          <li><strong>Welcome message</strong> — the headline and subheadline your visitor sees first. Keep it short (2 lines max)</li>
          <li><strong>Questions</strong> — write 3 short prompts. Each becomes its own video take</li>
          <li><strong>Thank-you message</strong> — what shows after they submit. Add a redirect button if you're delivering a gift</li>
          <li><strong>Buttons</strong> — corner style (curved or sharp), record-button placement (above or below video), and button labels/colors</li>
          <li><strong>Settings</strong> — max recording length, allow-text toggle, optional webhook for Slack/Zapier notifications</li>
          <li><strong>Email templates</strong> — copy your fill-in-the-blank 5-email sequence here. The page auto-fills your recording URL</li>
          <li><strong>Share</strong> — three share options: an iframe embed (recommended), a direct shareable URL, and a short link</li>
        </ol>
      </li>
      <li>On the <strong>Share</strong> tab, copy the <strong>iframe embed</strong> snippet. That's what you'll paste into your website.</li>
    </ol>
  </div>

  <div class="card">
    <span class="step-num">6</span>
    <h3>Section 6 — Embed it on your site (or just send the link)</h3>
    <p>Two ways to put your form in front of customers:</p>
    <ol>
      <li><strong>Embed it.</strong> Paste the iframe snippet from section 5 step 4 into any page on your website — GoHighLevel, WordPress, Webflow, Squarespace, Carrd, ClickFunnels, Kajabi, custom HTML. The recorder appears on your page like it was always part of it.</li>
      <li><strong>Or send the direct link.</strong> Use the short link from the Share tab in your emails, SMS, or DMs. Customers tap it and record straight from their phone — no need for them to visit your website at all.</li>
    </ol>
    <p style="font-size: 13px; color: var(--muted); margin-top: 12px;"><strong>You're live.</strong> Send the first email from the template (section 7 below) and watch testimonials land in your dashboard's Submissions tab.</p>
  </div>

  {{TIER_BLOCK}}

  <div class="card">
    <span class="step-num">7</span>
    <h3>Section 7 — Your 5-day testimonial collection sequence (template)</h3>
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
    <span class="step-num">8</span>
    <h3>Section 8 — Fields you'll fill into the email template</h3>
    <p>The same bracketed fields appear across the 5-email sequence. Decide each one once, replace consistently.</p>
    <ul style="font-size: 14px; line-height: 1.8; margin-top: 12px; padding-left: 20px;">
      <li><strong>[PROGRAM NAME]</strong> — the cohort/course/program they bought</li>
      <li><strong>[OPENING IT AGAIN / etc.]</strong> — what you're doing next that needs the testimonials</li>
      <li><strong>[TIMEFRAME]</strong> — when you need them by</li>
      <li><strong>[SPECIFIC TRANSFORMATION]</strong> — the actual change your program produces, in plain language</li>
      <li><strong>[GIFT NAME + DESCRIPTION]</strong> — what you're giving them in exchange. Real value. Don't hype it.</li>
      <li><strong>[CTA TEXT]</strong> + <strong>[RECORDING PAGE URL]</strong> — appears in every email. Pull the recording URL from the Share tab in your dashboard.</li>
      <li><strong>[SIGN-OFF]</strong> — "Hugs," / "Talk soon," / "—" / whatever fits your voice</li>
      <li><strong>[YOUR NAME]</strong></li>
      <li><strong>[YOUR AUDIENCE]</strong> — what you call them ("guitarists" / "founders" / "copywriters")</li>
      <li><strong>[SMALL-WIN EXAMPLE]</strong> — the specific kind of quiet success you want stories about</li>
    </ul>
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
