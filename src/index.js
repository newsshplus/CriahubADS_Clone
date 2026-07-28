// ============================================================
// CriaHub Automation — Worker principal
// ============================================================

import { connect } from "cloudflare:sockets";

const IG_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const IG_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const IG_GRAPH_BASE = "https://graph.instagram.com/v21.0";
const IG_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
  "pages_show_list",
  "pages_read_engagement",
].join(",");

const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const TIKTOK_API_BASE = "https://open.tiktokapis.com/v2";
const TIKTOK_SCOPES = [
  "user.info.basic",
  "video.list",
  "comment.read",
  "comment.write",
].join(",");

import adminHtml from "./admin.html";
import landingHtml from "./landing.html";
import authHtml from "./auth.html";
import privacyHtml from "./privacy.html";
import termsHtml from "./terms.html";
import contactHtml from "./contact.html";
import helpTiktokHtml from "./help-tiktok.html";

// ============================================================
// Raw SMTP via TCP sockets (Cloudflare Workers compatible)
// Uses the real cloudflare:sockets API: secureTransport 'on' for
// implicit TLS (port 465 style) and 'starttls' + sock.startTls()
// to upgrade the SAME connection in place (port 587 style).
// Opening a brand-new "secure" connection after STARTTLS (the old
// approach) is not how this API works and caused every STARTTLS
// send to fail with "This WritableStream has been closed".
// ============================================================
async function sendEmail(cfg, to, subject, htmlBody) {
  const host = cfg.smtp_host;
  const port = parseInt(cfg.smtp_port) || 587;
  const user = cfg.smtp_user || "";
  const pass = cfg.smtp_pass || "";
  const fromName = cfg.smtp_from_name || "CriaHub";
  const fromEmail = cfg.smtp_from_email || user;
  if (!host) throw new Error("SMTP host nao configurado");
  if (!to) throw new Error("Destinatario nao especificado");

  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));

  function wrap(sock) {
    const writer = sock.writable.getWriter();
    const dec = new TextDecoderStream();
    const reader = sock.readable.pipeThrough(dec).getReader();
    return { sock, writer, reader, alive: true };
  }

  function closeConn(c) {
    if (!c || !c.alive) return;
    c.alive = false;
    try { c.writer.releaseLock(); } catch(_) {}
    try { c.reader.cancel(); } catch(_) {}
    try { c.sock.close(); } catch(_) {}
  }

  async function readResponse(reader) {
    let out = "";
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise(res => setTimeout(() => res({ value: undefined, done: true }), 10000))
      ]);
      if (value) out += value;
      if (done) break;
      const lines = out.split("\r\n");
      for (const l of lines) {
        if (l.length >= 4 && l[3] === ' ' && /^\d{3}/.test(l)) return out.trim();
      }
    }
    return out.trim();
  }

  async function smtpCmd(c, data) {
    if (!c.alive) throw new Error("Conexao SMTP ja foi fechada");
    if (c.writer.desiredSize === null) { c.alive = false; throw new Error("Conexao SMTP perdida inesperadamente"); }
    await c.writer.write(new TextEncoder().encode(data + "\r\n"));
    const resp = await readResponse(c.reader);
    const code = parseInt(resp.substring(0, 3)) || 0;
    if (code >= 400) throw new Error("SMTP " + data.split(" ")[0] + " erro " + code + ": " + resp.substring(0, 200));
    return resp;
  }

  function buildEmail() {
    return [
      'From: "' + fromName + '" <' + fromEmail + '>',
      "To: " + to,
      "Subject: " + subject,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
      "",
      htmlBody,
      ".",
      ""
    ].join("\r\n");
  }

  async function doSend(c) {
    await smtpCmd(c, "EHLO criahub.workers.dev");
    if (user && pass) {
      await smtpCmd(c, "AUTH LOGIN");
      await smtpCmd(c, b64(user));
      await smtpCmd(c, b64(pass));
    }
    await smtpCmd(c, "MAIL FROM:<" + fromEmail + ">");
    await smtpCmd(c, "RCPT TO:<" + to + ">");
    await smtpCmd(c, "DATA");
    if (c.writer.desiredSize === null) { c.alive = false; throw new Error("Conexao SMTP perdida antes de enviar corpo"); }
    await c.writer.write(new TextEncoder().encode(buildEmail()));
    await new Promise(d => setTimeout(d, 1000));
    const dataResp = await readResponse(c.reader);
    if (!dataResp.startsWith("250")) throw new Error("SMTP DATA erro: " + dataResp.substring(0, 200));
    await smtpCmd(c, "QUIT").catch(() => {});
  }

  const tlsMode = cfg.smtp_use_tls;
  const directTls = (tlsMode === 1) || (port === 465);

  if (directTls) {
    // Implicit TLS from the very first byte (classic port 465 behavior)
    const sock = connect({ hostname: host, port: Number(port) }, { secureTransport: "on" });
    const c = wrap(sock);
    try {
      await sock.opened;
      await readResponse(c.reader); // discard the server's initial greeting banner
      await doSend(c);
      return true;
    } finally { closeConn(c); }
  }

  // STARTTLS path (classic port 587 behavior): connect in plain/starttls
  // mode, talk plaintext, then upgrade the SAME TCP connection to TLS
  // via sock.startTls() before authenticating and sending the message.
  const sock = connect({ hostname: host, port: Number(port) }, { secureTransport: "starttls" });
  let c = wrap(sock);
  try {
    await sock.opened;
    await readResponse(c.reader); // discard the server's initial greeting banner
    await smtpCmd(c, "EHLO criahub.workers.dev");
    let starttlsOk = false;
    try {
      const r = await smtpCmd(c, "STARTTLS");
      starttlsOk = r.startsWith("220");
    } catch(_) {}
    if (starttlsOk) {
      try { c.writer.releaseLock(); } catch(_) {}
      try { c.reader.cancel(); } catch(_) {}
      const secureSock = sock.startTls();
      c = wrap(secureSock);
    }
    await doSend(c); // re-issues EHLO, which is required right after the TLS upgrade
    return true;
  } finally {
    closeConn(c);
  }
}

async function getUserPlanLimits(db, userId) {
  const user = await db.prepare('SELECT u.plan_id, p.max_accounts, p.max_dms_month, p.max_campaigns, p.price_eur_monthly FROM saas_users u LEFT JOIN saas_plans p ON u.plan_id = p.id WHERE u.id = ?').bind(userId).first();
  return user;
}

async function getUsageCounts(db, userId) {
  const [contacts, dms, automations, accounts] = await Promise.all([
    db.prepare('SELECT COUNT(*) as c FROM leads WHERE user_id = ?').bind(userId).first(),
    db.prepare(`SELECT COUNT(*) as c FROM activity_log WHERE event_type = 'dm_sent' AND ig_account_id IN
      (SELECT id FROM ig_accounts WHERE client_id IN (SELECT id FROM clients WHERE email = (SELECT email FROM saas_users WHERE id = ?)))`).bind(userId).first(),
    db.prepare('SELECT COUNT(*) as c FROM campaigns WHERE ig_account_id IN (SELECT id FROM ig_accounts WHERE client_id IN (SELECT id FROM clients WHERE email = (SELECT email FROM saas_users WHERE id = ?)))').bind(userId).first(),
    db.prepare('SELECT COUNT(*) as c FROM ig_accounts WHERE client_id IN (SELECT id FROM clients WHERE email = (SELECT email FROM saas_users WHERE id = ?))').bind(userId).first(),
  ]);
  return {
    contacts: contacts?.c || 0,
    dms: dms?.c || 0,
    automations: automations?.c || 0,
    accounts: accounts?.c || 0,
  };
}

async function checkPlanLimit(db, userId, type) {
  const plan = await getUserPlanLimits(db, userId);
  if (!plan) return { ok: true };
  const usage = await getUsageCounts(db, userId);
  switch(type) {
    case 'contacts':
      if (plan.max_contacts > 0 && usage.contacts >= plan.max_contacts)
        return { ok: false, limit: plan.max_contacts, usage: usage.contacts, type: 'contactos' };
      break;
    case 'automations':
      if (plan.max_campaigns > 0 && usage.automations >= plan.max_campaigns)
        return { ok: false, limit: plan.max_campaigns, usage: usage.automations, type: 'automações' };
      break;
    case 'accounts':
      if (plan.max_accounts > 0 && usage.accounts >= plan.max_accounts)
        return { ok: false, limit: plan.max_accounts, usage: usage.accounts, type: 'contas Instagram' };
      break;
  }
  return { ok: true };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // Webhook GET verification
      const mode = url.searchParams.get("hub.mode");
      const challenge = url.searchParams.get("hub.challenge");
      const verifyToken = url.searchParams.get("hub.verify_token");

      if (method === "GET" && mode === "subscribe" && challenge) {
        if (verifyToken !== env.WEBHOOK_VERIFY_TOKEN) {
          return textResponse("Forbidden", 403);
        }
        console.log("Webhook verified successfully");
        return textResponse(challenge);
      }

      // GET /debug/webhook — view last 20 raw webhook payloads (admin only)
      if (method === "GET" && path === "/debug/webhook") {
        const sessionToken = url.searchParams.get("token");
        if (!sessionToken) return jsonResponse({ error: "No token" }, 401);
        const session = await env.criahub_db.prepare("SELECT * FROM processed_events WHERE event_id = ?").bind(`session_${sessionToken}`).first();
        if (!session) return jsonResponse({ error: "Invalid session" }, 401);
        try {
          const logs = await env.criahub_db.prepare("SELECT * FROM webhook_log ORDER BY rowid DESC LIMIT 20").all();
          return jsonResponse({ logs: logs.results || [] });
        } catch (e) {
          return jsonResponse({ error: e.message }, 500);
        }
      }

      // POST /debug/webhook-test — send a fake webhook event to test processing
      if (method === "POST" && path === "/debug/webhook-test") {
        const testBody = {
          object: "instagram",
          entry: [{
            id: "27608614755435050",
            time: Math.floor(Date.now() / 1000),
            changes: [{
              field: "comments",
              value: {
                id: "debug_" + Date.now(),
                text: "debug test comment",
                from: { id: "999999", username: "debug_test_user" }
              }
            }]
          }]
        };
        return handleWebhook(new Request(request.url, { method: "POST", body: JSON.stringify(testBody), headers: { "Content-Type": "application/json" } }), env);
      }

      // POST / webhook events
      if (method === "POST" && path === "/") {
        return handleWebhook(request, env);
      }

      // === PWA: Manifest ===
      if (method === "GET" && path === "/manifest.json") {
        return new Response(JSON.stringify({
          name: "CriaHub - Automação Instagram",
          short_name: "CriaHub",
          description: "Automatiza as tuas vendas no Instagram com IA",
          start_url: "/",
          display: "standalone",
          background_color: "#0a0a0f",
          theme_color: "#6c5ce7",
          orientation: "any",
          categories: ["business", "productivity"],
          lang: "pt-PT",
          icons: [
            { src: "/icon-192.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any" },
            { src: "/icon-512.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any" }
          ]
        }), { headers: { "Content-Type": "application/json; charset=utf-8" } });
      }

      // === PWA: Service Worker ===
      if (method === "GET" && path === "/sw.js") {
        const swCode = `
const CACHE_NAME='criahub-v1';
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(['/','/auth','/admin','/manifest.json'])));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE_NAME).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;if(e.request.url.includes('/admin/api/')||e.request.url.includes('/auth/')){e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));return}e.respondWith(caches.match(e.request).then(c=>{const f=fetch(e.request).then(r=>{if(r&&r.status===200){const cl=r.clone();caches.open(CACHE_NAME).then(ca=>ca.put(e.request,cl))}return r}).catch(()=>c);return c||f}))});`;
        return new Response(swCode, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
      }

      // === PWA: Icons ===
      if (method === "GET" && (path === "/icon-192.svg" || path === "/icon-512.svg")) {
        const size = path.includes("192") ? 192 : 512;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#6c5ce7"/><stop offset="50%" style="stop-color:#a855f7"/><stop offset="100%" style="stop-color:#ec4899"/></linearGradient></defs><rect width="${size}" height="${size}" rx="${Math.round(size*0.2)}" fill="url(#g)"/><text x="${size/2}" y="${size*0.63}" text-anchor="middle" font-family="Arial,sans-serif" font-weight="900" font-size="${size*0.38}" fill="white">C</text></svg>`;
        return new Response(svg, { headers: { "Content-Type": "image/svg+xml; charset=utf-8" } });
      }

      // === PWA: Apple Touch Icon ===
      if (method === "GET" && path === "/apple-touch-icon.png") {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#6c5ce7"/><stop offset="50%" style="stop-color:#a855f7"/><stop offset="100%" style="stop-color:#ec4899"/></linearGradient></defs><rect width="180" height="180" rx="40" fill="url(#g)"/><text x="90" y="113" text-anchor="middle" font-family="Arial,sans-serif" font-weight="900" font-size="68" fill="white">C</text></svg>`;
        return new Response(svg, { headers: { "Content-Type": "image/svg+xml; charset=utf-8" } });
      }

      // === ADMIN PANEL ===
      if (method === "GET" && path === "/admin") {
        return new Response(adminHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // === ADMIN API ===
      if (path.startsWith("/admin/api/")) {
        return handleAdminApi(request, env, path, method);
      }

      // === LEGACY ROUTES (kept for backwards compat) ===
      if (method === "POST" && path === "/admin/clients") {
        return handleCreateClient(request, env);
      }
      if (method === "POST" && path === "/admin/activate-automation") {
        return handleActivateAutomation(request, env);
      }

      // === OAUTH ===
      if (method === "GET" && path === "/connect") {
        return handleConnect(url, env);
      }
      if (method === "GET" && path === "/oauth/callback") {
        return handleOAuthCallback(url, env);
      }

      // === TIKTOK OAUTH ===
      if (method === "GET" && path === "/tiktok/connect") {
        return handleTikTokConnect(url, env);
      }
      if (method === "GET" && path === "/tiktok/callback") {
        return handleTikTokCallback(url, env);
      }

      // === FACEBOOK OAUTH (para Page Access Token — replies) ===
      if (method === "GET" && path === "/fb/connect") {
        return handleFBConnect(url, env);
      }
      if (method === "GET" && path === "/fb/callback") {
        return handleFBCallback(url, env);
      }
      if (method === "GET" && path === "/tiktok/webhook") {
        return handleTikTokWebhookVerify(url, env);
      }
      if (method === "POST" && path === "/tiktok/webhook") {
        return handleTikTokWebhook(request, env);
      }

      // === SaaS: Landing Page ===
      if (method === "GET" && (path === "/" || path === "/lp")) {
        return new Response(landingHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // === SaaS: Auth Page ===
      if (method === "GET" && path === "/auth") {
        return new Response(authHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // === SaaS: Auth (register/login) ===
      if (path === "/auth/register" && method === "POST") {
        return handleRegister(request, env);
      }
      if (path === "/auth/login" && method === "POST") {
        return handleLogin(request, env);
      }
      if (path === "/auth/logout" && method === "POST") {
        return handleLogout(request, env);
      }

      // === SaaS: Plans ===
      if (path === "/api/plans" && method === "GET") {
        return handleGetPlans(env);
      }

      // === SaaS: Usage ===
      if (path === "/api/usage" && method === "GET") {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        if (!token) return jsonResponse({ error: "Unauthorized" }, 401);
        const userSession = await env.criahub_db.prepare("SELECT value FROM system_config WHERE key = ?").bind("session_user_" + token).first();
        if (!userSession) return jsonResponse({ error: "Invalid session" }, 401);
        const userId = userSession.value;
        const plan = await getUserPlanLimits(env.criahub_db, userId);
        const usage = await getUsageCounts(env.criahub_db, userId);
        return jsonResponse({ plan: plan || { plan_id: 'free', max_accounts: 1, max_dms_month: 500, max_campaigns: 3, price_eur_monthly: 0 }, usage });
      }

      // === SaaS: Client Notifications ===
      if (path.startsWith("/api/notifications")) {
        return handleClientNotifications(request, env, path, method);
      }

      // === Static Pages: Privacy, Terms, Contact, Help ===
      if (method === "GET" && path === "/privacy") {
        return new Response(privacyHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (method === "GET" && path === "/terms") {
        return new Response(termsHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (method === "GET" && path === "/contact") {
        return new Response(contactHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (method === "GET" && path === "/help/tiktok") {
        return new Response(helpTiktokHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      // === WhatsApp CRM API ===
      if (path.startsWith("/api/whatsapp")) {
        return handleWhatsApp(request, env, path, method);
      }

      // === TikTok API ===
      if (path.startsWith("/api/tiktok")) {
        return handleTikTok(request, env, path, method);
      }

      // === Meta Ads API ===
      if (path.startsWith("/api/meta-ads")) {
        return handleMetaAds(request, env, path, method);
      }

      // === GA4 API ===
      if (path.startsWith("/api/ga4")) {
        return handleGA4(request, env, path, method);
      }

      // === Leads API ===
      if (path.startsWith("/api/leads")) {
        return handleLeads(request, env, path, method);
      }

      // === Health Check ===
      if (path === "/health" || path === "/healthz") {
        return jsonResponse({ ok: true, status: "healthy", timestamp: new Date().toISOString(), version: "1.0.0" });
      }

      // === Contact Form ===
      if (path === "/api/contact" && method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body || !body.name || !body.email || !body.subject || !body.description) {
          return jsonResponse({ error: "Campos obrigatórios: name, email, subject, description" }, 400);
        }
        await env.criahub_db.prepare(`INSERT INTO contact_submissions (name, email, phone, subject, description)
          VALUES (?, ?, ?, ?, ?)`).bind(body.name, body.email, body.phone || "", body.subject, body.description).run();

        // Try to send email via SMTP if configured
        let emailSent = false;
        try {
          const smtp = await env.criahub_db.prepare("SELECT * FROM smtp_config WHERE id = 1").first();
          if (smtp && smtp.smtp_host && smtp.recipient_email) {
            await sendEmail(smtp, smtp.recipient_email,
              `[CriaHub Contact] ${body.subject}`,
              `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
                <h2 style="color:#6c5ce7">Nova mensagem de contacto</h2>
                <table style="width:100%;border-collapse:collapse">
                  <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee">Nome:</td><td style="padding:8px;border-bottom:1px solid #eee">${body.name}</td></tr>
                  <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee">Email:</td><td style="padding:8px;border-bottom:1px solid #eee">${body.email}</td></tr>
                  ${body.phone ? '<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee">Telefone:</td><td style="padding:8px;border-bottom:1px solid #eee">' + body.phone + '</td></tr>' : ''}
                  <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee">Assunto:</td><td style="padding:8px;border-bottom:1px solid #eee">${body.subject}</td></tr>
                </table>
                <div style="margin-top:16px;padding:16px;background:#f8f9fc;border-radius:8px;border-left:4px solid #6c5ce7">
                  <p style="margin:0;white-space:pre-wrap">${body.description}</p>
                </div>
                <p style="margin-top:16px;font-size:12px;color:#888">Enviado via formulário de contacto do CriaHub</p>
              </div>`
            );
            emailSent = true;
          }
        } catch (e) {
          console.log("SMTP send failed:", e.message);
        }
        return jsonResponse({ ok: true, emailSent });
      }

      return textResponse("Not found.", 404);
    } catch (err) {
      console.error("Unhandled error:", err);
      return textResponse("Internal error: " + err.message, 500);
    }
  },
};

// ------------------------------------------------------------
// POST /admin/clients — cria um cliente novo
// ------------------------------------------------------------
async function handleCreateClient(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const expected = `Bearer ${env.ADMIN_SECRET}`;
  if (authHeader !== expected) {
    return textResponse("Não autorizado.", 401);
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.name || !body.email) {
    return jsonResponse({ error: "Envie 'name' e 'email' no corpo da requisição." }, 400);
  }

  const clientId = "cli_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  await env.criahub_db
    .prepare("INSERT INTO clients (id, name, email) VALUES (?, ?, ?)")
    .bind(clientId, body.name, body.email)
    .run();

  const connectUrl = `${new URL(request.url).origin}/connect?client=${clientId}`;

  return jsonResponse({
    client_id: clientId,
    connect_url: connectUrl,
    message: "Cliente criado. Envie o connect_url para o cliente autorizar a conta do Instagram.",
  });
}

// ============================================================
// ADMIN API ROUTER
// ============================================================
async function handleAdminApi(request, env, path, method) {
  // Simple token auth
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace("Bearer ", "");

  // Login
  if (path === "/admin/api/login" && method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || body.password !== env.ADMIN_PANEL_PASSWORD) {
      return jsonResponse({ ok: false, error: "Senha incorreta" }, 401);
    }
    const sessionToken = crypto.randomUUID().replace(/-/g, "");
    try {
      await env.criahub_db.prepare("INSERT OR REPLACE INTO processed_events (event_id) VALUES (?)").bind("session_" + sessionToken).run();
    } catch (_) {}
    return jsonResponse({ ok: true, token: sessionToken });
  }

  // All other routes require valid session
  if (!token || token.length < 10) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const session = await env.criahub_db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").bind("session_" + token).first();
  if (!session) {
    return jsonResponse({ error: "Invalid session" }, 401);
  }

  // === SMTP CONFIG ===
  if (path === "/admin/api/smtp" && method === "GET") {
    const smtp = await env.criahub_db.prepare("SELECT * FROM smtp_config WHERE id = 1").first();
    return jsonResponse({ smtp: smtp || { smtp_host: "", smtp_port: 587, smtp_user: "", smtp_pass: "", smtp_from_email: "", smtp_from_name: "CriaHub", smtp_use_tls: 1, recipient_email: "" } });
  }
  if (path === "/admin/api/smtp" && method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body) return jsonResponse({ error: "Invalid body" }, 400);
    await env.criahub_db.prepare(`INSERT OR REPLACE INTO smtp_config (id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_email, smtp_from_name, smtp_use_tls, recipient_email, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).bind(
      body.smtp_host || "", body.smtp_port || 587, body.smtp_user || "", body.smtp_pass || "",
      body.smtp_from_email || "", body.smtp_from_name || "CriaHub", body.smtp_use_tls ? 1 : 0, body.recipient_email || ""
    ).run();
    return jsonResponse({ ok: true });
  }
  if (path === "/admin/api/smtp/test" && method === "POST") {
    try {
      const smtp = await env.criahub_db.prepare("SELECT * FROM smtp_config WHERE id = 1").first();
      if (!smtp || !smtp.smtp_host) return jsonResponse({ error: "SMTP não configurado" }, 400);
      await sendEmail(smtp, smtp.recipient_email,
        "[CriaHub] Teste de email SMTP",
        "<h2 style='color:#6c5ce7'>Email de teste enviado com sucesso!</h2><p>Se estás a ver isto, o SMTP está configurado corretamente.</p>"
      );
      return jsonResponse({ ok: true, message: "Email de teste enviado!" });
    } catch (e) {
      return jsonResponse({ error: "Erro ao enviar: " + e.message }, 500);
    }
  }

  // === CONTACT SUBMISSIONS (admin) ===
  if (path === "/admin/api/contacts-submissions" && method === "GET") {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") || "";
    let q = "SELECT * FROM contact_submissions";
    const params = [];
    if (status) { q += " WHERE status = ?"; params.push(status); }
    q += " ORDER BY created_at DESC LIMIT 100";
    const results = await env.criahub_db.prepare(q).bind(...params).all();
    return jsonResponse({ submissions: results.results || [] });
  }
  if (path.match(/^\/admin\/api\/contacts-submissions\/[^/]+$/) && method === "POST") {
    const subId = path.split("/")[4];
    const body = await request.json().catch(() => null);
    if (body && body.status) {
      await env.criahub_db.prepare("UPDATE contact_submissions SET status = ?, admin_notes = ? WHERE id = ?").bind(body.status, body.admin_notes || "", subId).run();
    }
    return jsonResponse({ ok: true });
  }

  // GET /admin/api/accounts
  if (path === "/admin/api/accounts" && method === "GET") {
    const rows = await env.criahub_db.prepare(`
      SELECT a.id, a.ig_user_id, a.username, a.status, a.token_expires_at, a.connected_at,
             a.client_id, c.name as client_name, a.page_id, a.page_access_token
      FROM ig_accounts a
      LEFT JOIN clients c ON a.client_id = c.id
      ORDER BY a.connected_at DESC
    `).all();
    return jsonResponse(rows.results || []);
  }

  // POST /admin/api/accounts/manual — add account with token directly
  if (path === "/admin/api/accounts/manual" && method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || !body.access_token || !body.ig_user_id) {
      return jsonResponse({ error: "access_token and ig_user_id required" }, 400);
    }

    // First verify the token works by fetching profile
    try {
      const profileUrl = new URL(`${IG_GRAPH_BASE}/me`);
      profileUrl.searchParams.set("fields", "id,username");
      profileUrl.searchParams.set("access_token", body.access_token);
      const profileRes = await fetch(profileUrl.toString());
      const profileData = await profileRes.json();
      if (!profileRes.ok || !profileData.id) {
        return jsonResponse({ error: "Token invalid or expired", details: profileData }, 400);
      }

      // Create or find client
      let clientId = body.client_id;
      if (!clientId && body.client_name) {
        clientId = "cli_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        await env.criahub_db.prepare("INSERT INTO clients (id, name, email, status) VALUES (?, ?, ?, 'active')").bind(clientId, body.client_name, (body.client_name || '').toLowerCase().replace(/\s+/g, '@') + '@placeholder.com').run();
      }

      // Enforce plan limits on account linking
      const userId = session?.userId || session?.id;
      if (userId) {
        const limitCheck = await checkPlanLimit(env.criahub_db, userId, 'accounts');
        if (!limitCheck.ok) return jsonResponse({ error: `Limite do plano atingido: ${limitCheck.usage}/${limitCheck.limit} ${limitCheck.type}. Faça upgrade.`, upgrade_required: true }, 403);
      }

      const igAccountId = "ig_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      await env.criahub_db.prepare(`
        INSERT INTO ig_accounts (id, client_id, ig_user_id, username, access_token, token_expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'connected')
        ON CONFLICT(ig_user_id) DO UPDATE SET
          client_id = COALESCE(excluded.client_id, client_id),
          username = excluded.username,
          access_token = excluded.access_token,
          status = 'connected'
      `).bind(igAccountId, clientId || 'default', body.ig_user_id, profileData.username || body.username || null, body.access_token, body.token_expires_at || null).run();

      return jsonResponse({ ok: true, ig_account_id: igAccountId, username: profileData.username });
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // DELETE /admin/api/accounts/:id — handled by full cleanup endpoint below

  // GET /admin/api/clients
  if (path === "/admin/api/clients" && method === "GET") {
    const rows = await env.criahub_db.prepare("SELECT * FROM clients ORDER BY created_at DESC").all();
    return jsonResponse(rows.results || []);
  }

  // GET /admin/api/config — get all system config
  if (path === "/admin/api/config" && method === "GET") {
    const rows = await env.criahub_db.prepare("SELECT * FROM system_config").all();
    const config = {};
    (rows.results || []).forEach(r => { config[r.key] = r.value; });
    return jsonResponse(config);
  }

  // POST /admin/api/config — save system config
  if (path === "/admin/api/config" && method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body) return jsonResponse({ error: "Body required" }, 400);
    for (const [key, value] of Object.entries(body)) {
      await env.criahub_db.prepare(`
        INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(key, value).run();
    }
    return jsonResponse({ ok: true });
  }

  // POST /admin/api/accounts/:id/update-token
  if (path.match(/^\/admin\/api\/accounts\/[^/]+\/update-token$/) && method === "POST") {
    const id = path.split("/")[4];
    const body = await request.json().catch(() => null);
    if (!body || !body.access_token) return jsonResponse({ error: "access_token required" }, 400);

    // Verify token works
    try {
      const testUrl = new URL(`${IG_GRAPH_BASE}/me`);
      testUrl.searchParams.set("fields", "id,username");
      testUrl.searchParams.set("access_token", body.access_token);
      const testRes = await fetch(testUrl.toString());
      const testData = await testRes.json();
      if (!testRes.ok || !testData.id) {
        return jsonResponse({ error: "Token invalido ou expirado", details: testData }, 400);
      }
      await env.criahub_db.prepare("UPDATE ig_accounts SET access_token = ?, status = 'connected' WHERE id = ?").bind(body.access_token, id).run();
      return jsonResponse({ ok: true, username: testData.username });
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // GET /admin/api/campaigns
  if (path === "/admin/api/campaigns" && method === "GET") {
    const rows = await env.criahub_db.prepare(`
      SELECT c.*, a.username, a.ig_user_id FROM campaigns c
      LEFT JOIN ig_accounts a ON c.ig_account_id = a.id
      ORDER BY c.created_at DESC
    `).all();
    return jsonResponse(rows.results || []);
  }

  // POST /admin/api/campaigns
  if (path === "/admin/api/campaigns" && method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || !body.ig_user_id || !body.keyword) {
      return jsonResponse({ error: "ig_user_id and keyword required" }, 400);
    }
    const account = await env.criahub_db.prepare("SELECT id FROM ig_accounts WHERE ig_user_id = ? AND status = 'connected'").bind(body.ig_user_id).first();
    if (!account) return jsonResponse({ error: "Conta nao encontrada" }, 404);

    // Enforce plan limits
    const userId = session?.userId || session?.id;
    if (userId) {
      const limitCheck = await checkPlanLimit(env.criahub_db, userId, 'automations');
      if (!limitCheck.ok) return jsonResponse({ error: `Limite do plano atingido: ${limitCheck.usage}/${limitCheck.limit} ${limitCheck.type}. Faça upgrade.`, upgrade_required: true }, 403);
    }

    const id = "cmp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.criahub_db.prepare(`
      INSERT INTO campaigns (id, ig_account_id, keyword, private_reply_message, follow_request_message, delivery_content, media_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))
    `).bind(
      id, account.id, body.keyword,
      body.private_reply_message || "Fala ai! Recebemos seu comentario. Se quiser o conteudo completo, responda QUERO aqui mesmo.",
      body.follow_request_message || "Voce precisa seguir nosso perfil para receber o conteudo. Segue la e depois responde PRONTO aqui.",
      body.delivery_content || "www.criahub.global",
      body.media_id || null
    ).run();
    return jsonResponse({ campaign_id: id, ok: true });
  }

  // PUT /admin/api/campaigns/:id
  if (path.match(/^\/admin\/api\/campaigns\/[^/]+$/) && method === "PUT") {
    const id = path.split("/").pop();
    const body = await request.json().catch(() => null);
    if (!body) return jsonResponse({ error: "Body required" }, 400);
    await env.criahub_db.prepare(`
      UPDATE campaigns SET keyword = ?, private_reply_message = ?, follow_request_message = ?, delivery_content = ?, media_id = ? WHERE id = ?
    `).bind(body.keyword, body.private_reply_message, body.follow_request_message, body.delivery_content, body.media_id || null, id).run();
    return jsonResponse({ ok: true });
  }

  // DELETE /admin/api/campaigns/:id
  if (path.match(/^\/admin\/api\/campaigns\/[^/]+$/) && method === "DELETE") {
    const id = path.split("/").pop();
    await env.criahub_db.prepare("DELETE FROM conversation_state WHERE campaign_id = ?").bind(id).run();
    await env.criahub_db.prepare("DELETE FROM reply_variations WHERE campaign_id = ?").bind(id).run();
    await env.criahub_db.prepare("DELETE FROM campaigns WHERE id = ?").bind(id).run();
    return jsonResponse({ ok: true });
  }

  // POST /admin/api/campaigns/bulk-delete — delete multiple campaigns
  if (path === "/admin/api/campaigns/bulk-delete" && method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || !body.ids || !Array.isArray(body.ids) || body.ids.length === 0) {
      return jsonResponse({ error: "ids[] required" }, 400);
    }
    const ids = body.ids;
    const placeholders = ids.map(() => "?").join(",");
    await env.criahub_db.prepare(`DELETE FROM conversation_state WHERE campaign_id IN (${placeholders})`).bind(...ids).run();
    await env.criahub_db.prepare(`DELETE FROM reply_variations WHERE campaign_id IN (${placeholders})`).bind(...ids).run();
    await env.criahub_db.prepare(`DELETE FROM campaigns WHERE id IN (${placeholders})`).bind(...ids).run();
    return jsonResponse({ ok: true, deleted: ids.length });
  }

  // GET /admin/api/campaigns/duplicates — find campaigns with same media_id
  if (path === "/admin/api/campaigns/duplicates" && method === "GET") {
    const dupes = await env.criahub_db.prepare(`
      SELECT media_id, COUNT(*) as count, GROUP_CONCAT(id) as ids,
        GROUP_CONCAT(keyword) as keywords, GROUP_CONCAT(created_at) as dates
      FROM campaigns
      WHERE media_id IS NOT NULL AND media_id != ''
      GROUP BY media_id, ig_account_id
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
    `).all();
    return jsonResponse({ duplicates: dupes.results || [] });
  }

  // POST /admin/api/campaigns/bulk — create multiple campaigns at once with AI
  if (path === "/admin/api/campaigns/bulk" && method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || !body.ig_user_id || !body.posts || !body.posts.length) {
      return jsonResponse({ error: "ig_user_id and posts[] required" }, 400);
    }
    const account = await env.criahub_db.prepare("SELECT id, access_token FROM ig_accounts WHERE ig_user_id = ? AND status = 'connected'").bind(body.ig_user_id).first();
    if (!account) return jsonResponse({ error: "Conta nao encontrada" }, 404);

    // Enforce plan limits on bulk campaign creation
    const bulkUserId = session?.userId || session?.id;
    if (bulkUserId) {
      const limitCheck = await checkPlanLimit(env.criahub_db, bulkUserId, 'automations');
      if (!limitCheck.ok) return jsonResponse({ error: `Limite do plano atingido: ${limitCheck.usage}/${limitCheck.limit} ${limitCheck.type}. Faça upgrade.`, upgrade_required: true }, 403);
    }

    const defaultKeyword = body.default_keyword || "ACESSO";
    const created = [];
    const errors = [];

    for (const post of body.posts) {
      try {
        // Fetch caption if not provided
        let caption = post.caption || null;
        if (post.media_id && !caption) {
          try {
            const mediaRes = await fetch(`https://graph.instagram.com/${post.media_id}?fields=caption&access_token=${account.access_token}`);
            const mediaData = await mediaRes.json();
            caption = mediaData.caption || null;
          } catch (_) {}
        }

        // Generate AI messages based on post content
        const aiReply = await generateCommentReply(defaultKeyword, caption, body.delivery_content || "o conteudo", env);
        const aiFollow = await generateDMMessage("follow", caption, { private_reply_message: "", follow_request_message: "", delivery_content: body.delivery_content || "" }, null, env);
        const aiDelivery = await generateDMMessage("entrega", caption, { private_reply_message: "", follow_request_message: "", delivery_content: body.delivery_content || "" }, null, env);

        const id = "cmp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        await env.criahub_db.prepare(`
          INSERT INTO campaigns (id, ig_account_id, keyword, private_reply_message, follow_request_message, delivery_content, media_id, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))
        `).bind(
          id, account.id,
          post.keyword || defaultKeyword,
          aiReply || body.default_reply || "Fala ai! Recebemos seu comentario. Responda QUERO aqui.",
          aiFollow || body.default_follow || "Voce precisa seguir nosso perfil. Segue la e responde PRONTO.",
          aiDelivery || body.delivery_content || "www.criahub.global",
          post.media_id || null
        ).run();

        created.push({ id, keyword: post.keyword || defaultKeyword, media_id: post.media_id, caption: (caption || "").substring(0, 60) });
      } catch (err) {
        errors.push({ media_id: post.media_id, error: err.message });
      }
    }

    return jsonResponse({ ok: true, created: created.length, errors: errors.length, campaigns: created, errorList: errors });
  }

  // POST /admin/api/campaigns/:id/test-ai — test AI responses without sending
  if (path.match(/^\/admin\/api\/campaigns\/[^/]+\/test-ai$/) && method === "POST") {
    const id = path.split("/")[4];
    const body = await request.json().catch(() => null);
    const campaign = await env.criahub_db.prepare(`
      SELECT c.*, a.username, a.ig_user_id, a.access_token FROM campaigns c
      LEFT JOIN ig_accounts a ON c.ig_account_id = a.id
      WHERE c.id = ?
    `).bind(id).first();
    if (!campaign) return jsonResponse({ error: "Campanha nao encontrada" }, 404);

    // Fetch post caption
    let postCaption = null;
    if (campaign.media_id) {
      try {
        const mediaRes = await fetch(`https://graph.instagram.com/${campaign.media_id}?fields=caption&access_token=${campaign.access_token}`);
        const mediaData = await mediaRes.json();
        postCaption = mediaData.caption || null;
      } catch (_) {}
    }

    const testComment = (body && body.comment) || "Quero saber mais";
    const results = {};

    // Test comment reply
    results.commentReply = await generateCommentReply(testComment, postCaption, campaign.delivery_content || "o conteudo", env);

    // Test DM quero
    results.dmQuero = await generateDMMessage("quero", postCaption, campaign, null, env);

    // Test DM follow
    results.dmFollow = await generateDMMessage("follow", postCaption, campaign, null, env);

    // Test DM entrega
    results.dmEntrega = await generateDMMessage("entrega", postCaption, campaign, null, env);

    // Test comment classification
    results.classification = await classifyComment(testComment, postCaption, env);

    // Test public reply (for non-keyword comments)
    results.publicReply = await generatePublicReply(testComment, postCaption, results.classification, env);

    results.postCaption = postCaption;
    results.campaign = {
      keyword: campaign.keyword,
      reply: campaign.private_reply_message,
      follow: campaign.follow_request_message,
      delivery: campaign.delivery_content
    };

    return jsonResponse(results);
  }

  // POST /admin/api/campaigns/:id/clone
  if (path.match(/^\/admin\/api\/campaigns\/[^/]+\/clone$/) && method === "POST") {
    const sourceId = path.split("/")[4];
    const body = await request.json().catch(() => null);
    if (!body || !body.ig_user_id) return jsonResponse({ error: "ig_user_id required for clone" }, 400);

    const source = await env.criahub_db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(sourceId).first();
    if (!source) return jsonResponse({ error: "Source campaign not found" }, 404);

    const targetAccount = await env.criahub_db.prepare("SELECT id FROM ig_accounts WHERE ig_user_id = ? AND status = 'connected'").bind(body.ig_user_id).first();
    if (!targetAccount) return jsonResponse({ error: "Target account not found" }, 404);

    const newId = "cmp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.criahub_db.prepare(`
      INSERT INTO campaigns (id, ig_account_id, keyword, private_reply_message, follow_request_message, delivery_content, media_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))
    `).bind(newId, targetAccount.id, source.keyword, source.private_reply_message, source.follow_request_message, source.delivery_content, source.media_id).run();

    return jsonResponse({ campaign_id: newId, ok: true, message: "Campanha clonada com sucesso" });
  }

  // GET /admin/api/media/:ig_user_id
  if (path.match(/^\/admin\/api\/media\/[^/]+$/) && method === "GET") {
    const igUserId = path.split("/").pop();
    const account = await env.criahub_db.prepare("SELECT access_token FROM ig_accounts WHERE ig_user_id = ? AND status = 'connected'").bind(igUserId).first();
    if (!account) return jsonResponse({ error: "Conta nao encontrada" }, 404);

    try {
      const mediaUrl = new URL(`https://graph.instagram.com/me/media`);
      mediaUrl.searchParams.set("fields", "id,caption,media_type,media_url,thumbnail_url,timestamp,permalink");
      mediaUrl.searchParams.set("limit", "25");
      mediaUrl.searchParams.set("access_token", account.access_token);

      const res = await fetch(mediaUrl.toString());
      const data = await res.json();
      console.log("Media fetch response:", JSON.stringify(data).substring(0, 500));
      
      if (res.ok && data.data) {
        return jsonResponse(data.data);
      }
      
      if (data.error) {
        console.log("Media fetch error:", JSON.stringify(data.error));
        return jsonResponse({ error: "Erro ao buscar posts", details: data.error }, 400);
      }
      
      return jsonResponse({ error: "Nenhum post encontrado", details: data }, 400);
    } catch (err) {
      console.log("Media fetch exception:", err.message);
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // GET /admin/api/contacts
  if (path === "/admin/api/contacts" && method === "GET") {
    const rows = await env.criahub_db.prepare("SELECT * FROM contacts ORDER BY last_seen_at DESC LIMIT 200").all();
    return jsonResponse(rows.results || []);
  }

  // GET /admin/api/conversations
  if (path === "/admin/api/conversations" && method === "GET") {
    const rows = await env.criahub_db.prepare("SELECT * FROM conversation_state ORDER BY updated_at DESC LIMIT 200").all();
    return jsonResponse(rows.results || []);
  }

  // GET /admin/api/analytics — dashboard metrics
  if (path === "/admin/api/analytics" && method === "GET") {
    const totalCampaigns = await env.criahub_db.prepare("SELECT COUNT(*) as count FROM campaigns").first();
    const activeCampaigns = await env.criahub_db.prepare("SELECT COUNT(*) as count FROM campaigns WHERE status = 'active'").first();
    const totalContacts = await env.criahub_db.prepare("SELECT COUNT(*) as count FROM contacts").first();
    const totalDMsSent = await env.criahub_db.prepare("SELECT COUNT(*) as count FROM activity_log WHERE event_type = 'dm_sent'").first();
    const totalDMsFailed = await env.criahub_db.prepare("SELECT COUNT(*) as count FROM activity_log WHERE event_type = 'dm_failed'").first();
    const totalComments = await env.criahub_db.prepare("SELECT COUNT(*) as count FROM activity_log WHERE event_type = 'comment_received'").first();
    const totalEmails = await env.criahub_db.prepare("SELECT COUNT(*) as count FROM collected_emails").first();
    const connectedAccounts = await env.criahub_db.prepare("SELECT COUNT(*) as count FROM ig_accounts WHERE status = 'connected'").first();

    // Contacts today
    const contactsToday = await env.criahub_db.prepare("SELECT COUNT(*) as count FROM contacts WHERE first_seen_at >= date('now')").first();

    // DMs sent today
    const dmsToday = await env.criahub_db.prepare("SELECT COUNT(*) as count FROM activity_log WHERE event_type = 'dm_sent' AND created_at >= date('now')").first();

    // Top campaigns by DMs sent
    const topCampaigns = await env.criahub_db.prepare(`
      SELECT c.keyword, COUNT(*) as count
      FROM activity_log al
      JOIN campaigns c ON al.campaign_id = c.id
      WHERE al.event_type = 'dm_sent'
      GROUP BY al.campaign_id
      ORDER BY count DESC
      LIMIT 5
    `).all();

    // Activity last 7 days
    const activityByDay = await env.criahub_db.prepare(`
      SELECT date(created_at) as day, event_type, COUNT(*) as count
      FROM activity_log
      WHERE created_at >= date('now', '-7 days')
      GROUP BY day, event_type
      ORDER BY day
    `).all();

    // Conversation stages distribution
    const stagesDist = await env.criahub_db.prepare(`
      SELECT stage, COUNT(*) as count
      FROM conversation_state
      GROUP BY stage
    `).all();

    return jsonResponse({
      totalCampaigns: totalCampaigns?.count || 0,
      activeCampaigns: activeCampaigns?.count || 0,
      totalContacts: totalContacts?.count || 0,
      totalDMsSent: totalDMsSent?.count || 0,
      totalDMsFailed: totalDMsFailed?.count || 0,
      totalComments: totalComments?.count || 0,
      totalEmails: totalEmails?.count || 0,
      connectedAccounts: connectedAccounts?.count || 0,
      contactsToday: contactsToday?.count || 0,
      dmsToday: dmsToday?.count || 0,
      topCampaigns: topCampaigns?.results || [],
      activityByDay: activityByDay?.results || [],
      stagesDist: stagesDist?.results || []
    });
  }

  // GET /admin/api/activity — activity log
  if (path === "/admin/api/activity" && method === "GET") {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const rows = await env.criahub_db.prepare(`
      SELECT al.*, c.username as contact_username, camp.keyword as campaign_keyword
      FROM activity_log al
      LEFT JOIN contacts c ON al.contact_id = c.id
      LEFT JOIN campaigns camp ON al.campaign_id = camp.id
      ORDER BY al.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all();
    const total = await env.criahub_db.prepare("SELECT COUNT(*) as count FROM activity_log").first();
    return jsonResponse({ items: rows.results || [], total: total?.count || 0 });
  }

  // GET /admin/api/emails — collected emails
  if (path === "/admin/api/emails" && method === "GET") {
    const rows = await env.criahub_db.prepare(`
      SELECT ce.*, c.username as contact_username, camp.keyword as campaign_keyword
      FROM collected_emails ce
      LEFT JOIN contacts c ON ce.contact_id = c.id
      LEFT JOIN campaigns camp ON ce.campaign_id = camp.id
      ORDER BY ce.created_at DESC
      LIMIT 200
    `).all();
    return jsonResponse(rows.results || []);
  }

  // POST /admin/api/campaigns/:id/variations — add reply variations
  if (path.match(/^\/admin\/api\/campaigns\/[^/]+\/variations$/) && method === "POST") {
    const id = path.split("/")[4];
    const body = await request.json().catch(() => null);
    if (!body || !body.variation_type || !body.message) {
      return jsonResponse({ error: "variation_type and message required" }, 400);
    }
    await env.criahub_db.prepare(`
      INSERT INTO reply_variations (campaign_id, variation_type, message) VALUES (?, ?, ?)
    `).bind(id, body.variation_type, body.message).run();
    return jsonResponse({ ok: true });
  }

  // GET /admin/api/campaigns/:id/variations — get reply variations
  if (path.match(/^\/admin\/api\/campaigns\/[^/]+\/variations$/) && method === "GET") {
    const id = path.split("/")[4];
    const rows = await env.criahub_db.prepare("SELECT * FROM reply_variations WHERE campaign_id = ?").bind(id).all();
    return jsonResponse(rows.results || []);
  }

  // DELETE /admin/api/variations/:id — delete a variation
  if (path.match(/^\/admin\/api\/variations\/[^/]+$/) && method === "DELETE") {
    const id = path.split("/").pop();
    await env.criahub_db.prepare("DELETE FROM reply_variations WHERE id = ?").bind(id).run();
    return jsonResponse({ ok: true });
  }

  // POST /admin/api/campaigns/:id/schedule-followup — schedule follow-up
  if (path.match(/^\/admin\/api\/campaigns\/[^/]+\/schedule-followup$/) && method === "POST") {
    const id = path.split("/")[4];
    const body = await request.json().catch(() => null);
    if (!body || !body.contact_id || !body.message) {
      return jsonResponse({ error: "contact_id and message required" }, 400);
    }
    const hours = body.hours || 24;
    const followUpId = "fu_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.criahub_db.prepare(`
      INSERT INTO follow_ups (id, ig_account_id, contact_id, campaign_id, message, send_after_hours, scheduled_at)
      SELECT ?, c.ig_account_id, ?, ?, ?, ?, datetime('now', '+' || ? || ' hours')
      FROM campaigns c WHERE c.id = ?
    `).bind(followUpId, body.contact_id, id, body.message, hours, hours, id).run();
    return jsonResponse({ ok: true, follow_up_id: followUpId });
  }

  // POST /admin/api/admin/clients
  if (path === "/admin/api/clients" && method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || !body.name || !body.email) {
      return jsonResponse({ error: "name and email required" }, 400);
    }
    const clientId = "cli_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.criahub_db.prepare("INSERT INTO clients (id, name, email) VALUES (?, ?, ?)").bind(clientId, body.name, body.email).run();
    return jsonResponse({ client_id: clientId, connect_url: `${new URL(request.url).origin}/connect?client=${clientId}` });
  }

  // GET /admin/api/finance — SaaS financial metrics
  if (path === "/admin/api/finance" && method === "GET") {
    return handleGetFinance(env);
  }

  // GET /admin/api/saas-users — all registered SaaS users
  if (path === "/admin/api/saas-users" && method === "GET") {
    return handleGetSaaSUsers(env);
  }

  // GET /admin/api/subscriptions — all subscriptions
  if (path === "/admin/api/subscriptions" && method === "GET") {
    return handleGetSubscriptions(env);
  }

  // POST /admin/api/saas-users/:id/assign-plan — assign a plan to a user
  if (path.match(/^\/admin\/api\/saas-users\/[^/]+\/assign-plan$/) && method === "POST") {
    const userId = path.split("/")[4];
    const body = await request.json().catch(() => null);
    if (!body || !body.plan_id) return jsonResponse({ error: "plan_id required" }, 400);

    const plan = await env.criahub_db.prepare("SELECT id FROM saas_plans WHERE id = ? AND active = 1").bind(body.plan_id).first();
    if (!plan) return jsonResponse({ error: "Plan not found" }, 404);

    // saas_subscriptions has UNIQUE(user_id) — one row per user. Cancelling the
    // old row and then INSERTing a new one for the same user_id always collided
    // with that constraint (the cancelled row still occupies the user_id slot),
    // so every plan change after the first one failed. Upsert instead.
    const subId = "sub_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const expiresAt = body.expires_at || null;
    try {
      await env.criahub_db.prepare(`
        INSERT INTO saas_subscriptions (id, user_id, plan_id, status, started_at, expires_at, cancelled_at)
        VALUES (?, ?, ?, 'active', datetime('now'), ?, NULL)
        ON CONFLICT(user_id) DO UPDATE SET
          plan_id = excluded.plan_id,
          status = 'active',
          started_at = datetime('now'),
          expires_at = excluded.expires_at,
          cancelled_at = NULL
      `).bind(subId, userId, body.plan_id, expiresAt).run();
    } catch (err) {
      return jsonResponse({ error: "Erro ao mudar plano: " + err.message }, 500);
    }

    // Also update saas_users.plan_id so the user's plan is reflected on their account
    try {
      await env.criahub_db.prepare("UPDATE saas_users SET plan_id = ?, updated_at = datetime('now') WHERE id = ?").bind(body.plan_id, userId).run();
    } catch (_) {}

    return jsonResponse({ ok: true });
  }

  // POST /admin/api/saas-users/:id/ban — ban a user
  if (path.match(/^\/admin\/api\/saas-users\/[^/]+\/ban$/) && method === "POST") {
    const userId = path.split("/")[4];
    await env.criahub_db.prepare("UPDATE saas_users SET status = 'banned' WHERE id = ?").bind(userId).run();
    await env.criahub_db.prepare("UPDATE saas_subscriptions SET status = 'cancelled', cancelled_at = datetime('now') WHERE user_id = ? AND status = 'active'").bind(userId).run();
    return jsonResponse({ ok: true });
  }

  // POST /admin/api/saas-users/:id/unban — unban a user
  if (path.match(/^\/admin\/api\/saas-users\/[^/]+\/unban$/) && method === "POST") {
    const userId = path.split("/")[4];
    await env.criahub_db.prepare("UPDATE saas_users SET status = 'active' WHERE id = ?").bind(userId).run();
    return jsonResponse({ ok: true });
  }

  // POST /admin/api/saas-users/:id/approve — approve pending user + create trial
  if (path.match(/^\/admin\/api\/saas-users\/[^/]+\/approve$/) && method === "POST") {
    const userId = path.split("/")[4];
    await env.criahub_db.prepare("UPDATE saas_users SET status = 'active', updated_at = datetime('now') WHERE id = ?").bind(userId).run();
    // Create 3-day trial
    const subId = "sub_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    try {
      await env.criahub_db.prepare(`
        INSERT INTO saas_subscriptions (id, user_id, plan_id, status, started_at, expires_at) VALUES (?, ?, 'plan_business', 'active', datetime('now'), ?)
        ON CONFLICT(user_id) DO UPDATE SET plan_id = 'plan_business', status = 'active', started_at = datetime('now'), expires_at = ?, cancelled_at = NULL
      `).bind(subId, userId, expiresAt, expiresAt).run();
    } catch (_) {}
    return jsonResponse({ ok: true });
  }

  // POST /admin/api/saas-users/:id/reject — reject pending user
  if (path.match(/^\/admin\/api\/saas-users\/[^/]+\/reject$/) && method === "POST") {
    const userId = path.split("/")[4];
    await env.criahub_db.prepare("UPDATE saas_users SET status = 'rejected', updated_at = datetime('now') WHERE id = ?").bind(userId).run();
    return jsonResponse({ ok: true });
  }

  // POST /admin/api/config/approval — toggle approval requirement
  if (path === "/admin/api/config/approval" && method === "POST") {
    const body = await request.json().catch(() => null);
    const enabled = body?.enabled ? '1' : '0';
    await env.criahub_db.prepare(`
      INSERT INTO system_config (key, value, updated_at) VALUES ('approval_required', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(enabled).run();
    return jsonResponse({ ok: true, enabled: enabled === '1' });
  }
  if (path === "/admin/api/config/approval" && method === "GET") {
    const cfg = await env.criahub_db.prepare("SELECT value FROM system_config WHERE key = 'approval_required'").first();
    return jsonResponse({ enabled: cfg?.value === '1' });
  }

  // DELETE /admin/api/accounts/:id — delete IG account and all related data
  if (path.match(/^\/admin\/api\/accounts\/[^/]+$/) && method === "DELETE") {
    const id = path.split("/")[4];
    const account = await env.criahub_db.prepare("SELECT id FROM ig_accounts WHERE id = ?").bind(id).first();
    if (!account) return jsonResponse({ error: "Account not found" }, 404);
    // Cleanup related data
    try {
      await env.criahub_db.prepare("DELETE FROM conversation_state WHERE campaign_id IN (SELECT id FROM campaigns WHERE ig_account_id = ?)").bind(id).run();
      await env.criahub_db.prepare("DELETE FROM activity_log WHERE ig_account_id = ?").bind(id).run();
      await env.criahub_db.prepare("DELETE FROM collected_emails WHERE ig_account_id = ?").bind(id).run();
      await env.criahub_db.prepare("DELETE FROM follow_ups WHERE ig_account_id = ?").bind(id).run();
      await env.criahub_db.prepare("DELETE FROM reply_variations WHERE campaign_id IN (SELECT id FROM campaigns WHERE ig_account_id = ?)").bind(id).run();
      await env.criahub_db.prepare("DELETE FROM campaigns WHERE ig_account_id = ?").bind(id).run();
      await env.criahub_db.prepare("DELETE FROM contacts WHERE ig_account_id = ?").bind(id).run();
      await env.criahub_db.prepare("DELETE FROM ig_accounts WHERE id = ?").bind(id).run();
    } catch (err) {
      return jsonResponse({ error: "Erro ao excluir: " + err.message }, 500);
    }
    return jsonResponse({ ok: true });
  }

  // POST /admin/api/payments — register a manual payment
  if (path === "/admin/api/payments" && method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || !body.user_id || !body.amount_eur) return jsonResponse({ error: "user_id and amount_eur required" }, 400);

    const user = await env.criahub_db.prepare("SELECT id FROM saas_users WHERE id = ?").bind(body.user_id).first();
    if (!user) return jsonResponse({ error: "User not found" }, 404);

    // Get active subscription
    const sub = await env.criahub_db.prepare("SELECT id FROM saas_subscriptions WHERE user_id = ? AND status = 'active'").bind(body.user_id).first();

    const paymentId = "pay_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.criahub_db.prepare(`
      INSERT INTO saas_payments (id, user_id, subscription_id, amount_eur, method, status, reference)
      VALUES (?, ?, ?, ?, ?, 'completed', ?)
    `).bind(paymentId, body.user_id, sub?.id || null, body.amount_eur, body.method || 'manual', body.reference || null).run();

    return jsonResponse({ ok: true, payment_id: paymentId });
  }

  // === CLIENT MANAGEMENT (SaaS Admin) ===

  // POST /admin/api/saas-users — create a new SaaS user
  if (path === "/admin/api/saas-users" && method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || !body.email || !body.name) return jsonResponse({ error: "email and name required" }, 400);
    const userId = "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const passwordHash = body.password ? await hashPassword(body.password) : "$ADMIN_HASH";
    try {
      await env.criahub_db.prepare(`
        INSERT INTO saas_users (id, email, password_hash, name, status) VALUES (?, ?, ?, ?, 'active')
      `).bind(userId, body.email, passwordHash, body.name).run();
      // Optionally assign a plan
      if (body.plan_id) {
        const plan = await env.criahub_db.prepare("SELECT id FROM saas_plans WHERE id = ? AND active = 1").bind(body.plan_id).first();
        if (plan) {
          const subId = "sub_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
          const expiresAt = body.expires_at || null;
          await env.criahub_db.prepare(`
            INSERT INTO saas_subscriptions (id, user_id, plan_id, status, started_at, expires_at) VALUES (?, ?, ?, 'active', datetime('now'), ?)
          `).bind(subId, userId, body.plan_id, expiresAt).run();
        }
      }
      return jsonResponse({ ok: true, user_id: userId });
    } catch (err) {
      if (err.message && err.message.includes("UNIQUE")) return jsonResponse({ error: "Email already exists" }, 400);
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // PUT /admin/api/saas-users/:id — update a SaaS user
  if (path.match(/^\/admin\/api\/saas-users\/[^/]+$/) && method === "PUT") {
    const userId = path.split("/")[4];
    const body = await request.json().catch(() => null);
    if (!body) return jsonResponse({ error: "Body required" }, 400);
    const sets = [];
    const params = [];
    if (body.name !== undefined) { sets.push("name = ?"); params.push(body.name); }
    if (body.email !== undefined) { sets.push("email = ?"); params.push(body.email); }
    if (body.status !== undefined) { sets.push("status = ?"); params.push(body.status); }
    if (body.password) {
      const pwHash = await hashPassword(body.password);
      sets.push("password_hash = ?"); params.push(pwHash);
    }
    if (!sets.length) return jsonResponse({ error: "Nothing to update" }, 400);
    sets.push("updated_at = datetime('now')");
    params.push(userId);
    try {
      await env.criahub_db.prepare(`UPDATE saas_users SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
      return jsonResponse({ ok: true });
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // DELETE /admin/api/saas-users/:id — delete a SaaS user and their subscriptions
  if (path.match(/^\/admin\/api\/saas-users\/[^/]+$/) && method === "DELETE") {
    const userId = path.split("/")[4];
    await env.criahub_db.prepare("DELETE FROM saas_subscriptions WHERE user_id = ?").bind(userId).run();
    await env.criahub_db.prepare("DELETE FROM saas_payments WHERE user_id = ?").bind(userId).run();
    await env.criahub_db.prepare("DELETE FROM user_notifications WHERE user_id = ?").bind(userId).run();
    await env.criahub_db.prepare("DELETE FROM saas_users WHERE id = ?").bind(userId).run();
    return jsonResponse({ ok: true });
  }

  // === NOTIFICATIONS (Admin Push) ===

  // POST /admin/api/notifications — create and broadcast a notification
  if (path === "/admin/api/notifications" && method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || !body.title || !body.message) return jsonResponse({ error: "title and message required" }, 400);
    const notifId = "notif_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.criahub_db.prepare(`
      INSERT INTO notifications (id, title, message, type, icon, link) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(notifId, body.title, body.message, body.type || 'info', body.icon || '📢', body.link || null).run();
    // Create user_notifications for every active user
    const users = await env.criahub_db.prepare("SELECT id FROM saas_users WHERE status = 'active'").all();
    for (const u of (users.results || [])) {
      const unId = "un_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      await env.criahub_db.prepare(`
        INSERT INTO user_notifications (id, notification_id, user_id) VALUES (?, ?, ?)
      `).bind(unId, notifId, u.id).run();
    }
    return jsonResponse({ ok: true, notification_id: notifId, sent_to: (users.results || []).length });
  }

  // GET /admin/api/notifications — list all notifications
  if (path === "/admin/api/notifications" && method === "GET") {
    const rows = await env.criahub_db.prepare(`
      SELECT n.*, (SELECT COUNT(*) FROM user_notifications WHERE notification_id = n.id) as total_sent,
             (SELECT COUNT(*) FROM user_notifications WHERE notification_id = n.id AND read = 1) as total_read
      FROM notifications n ORDER BY n.created_at DESC LIMIT 50
    `).all();
    return jsonResponse(rows.results || []);
  }

  // DELETE /admin/api/notifications/:id — delete a notification
  if (path.match(/^\/admin\/api\/notifications\/[^/]+$/) && method === "DELETE") {
    const notifId = path.split("/")[4];
    await env.criahub_db.prepare("DELETE FROM user_notifications WHERE notification_id = ?").bind(notifId).run();
    await env.criahub_db.prepare("DELETE FROM notifications WHERE id = ?").bind(notifId).run();
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Not found" }, 404);
}

// ============================================================
// CLIENT-FACING NOTIFICATIONS HANDLER
// ============================================================
async function handleClientNotifications(request, env, path, method) {
  // Helper: resolve SaaS user ID from session token
  async function resolveSaaSUser(token) {
    const row = await env.criahub_db.prepare("SELECT value FROM system_config WHERE key = ?").bind("session_user_" + token).first();
    if (!row) return null;
    const user = await env.criahub_db.prepare("SELECT id FROM saas_users WHERE id = ? AND status = 'active'").bind(row.value).first();
    return user || null;
  }

  // GET /api/notifications — get current user's notifications
  if (path === "/api/notifications" && method === "GET") {
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return jsonResponse({ error: "Unauthorized" }, 401);

    // Try admin session first (from processed_events)
    const adminSession = await env.criahub_db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").bind("session_" + token).first();
    if (adminSession) {
      // Admin user — return all notifications
      const rows = await env.criahub_db.prepare(`
        SELECT n.id as notif_id, n.title, n.message, n.type, n.icon, n.link, n.created_at, 0 as read
        FROM notifications n WHERE n.active = 1
        ORDER BY n.created_at DESC LIMIT 30
      `).all();
      const unread = await env.criahub_db.prepare("SELECT COUNT(*) as count FROM notifications WHERE active = 1").first();
      return jsonResponse({ notifications: rows.results || [], unread: unread?.count || 0 });
    }

    // Try SaaS user session
    const user = await resolveSaaSUser(token);
    if (!user) return jsonResponse({ error: "Invalid session" }, 401);
    const rows = await env.criahub_db.prepare(`
      SELECT un.id as user_notif_id, un.read, n.id as notif_id, n.title, n.message, n.type, n.icon, n.link, n.created_at
      FROM user_notifications un
      JOIN notifications n ON un.notification_id = n.id
      WHERE un.user_id = ? AND n.active = 1
      ORDER BY n.created_at DESC LIMIT 30
    `).bind(user.id).all();
    const unread = await env.criahub_db.prepare(`
      SELECT COUNT(*) as count FROM user_notifications un JOIN notifications n ON un.notification_id = n.id
      WHERE un.user_id = ? AND un.read = 0 AND n.active = 1
    `).bind(user.id).first();
    return jsonResponse({ notifications: rows.results || [], unread: unread?.count || 0 });
  }

  // POST /api/notifications/:id/read — mark a notification as read
  if (path.match(/^\/api\/notifications\/[^/]+\/read$/) && method === "POST") {
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return jsonResponse({ error: "Unauthorized" }, 401);
    const notifId = path.split("/")[3];
    const adminSession = await env.criahub_db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").bind("session_" + token).first();
    if (!adminSession) {
      const user = await resolveSaaSUser(token);
      if (!user) return jsonResponse({ error: "Invalid session" }, 401);
      // Mark user's notification as read
      await env.criahub_db.prepare("UPDATE user_notifications SET read = 1 WHERE notification_id = ? AND user_id = ?").bind(notifId, user.id).run();
    }
    return jsonResponse({ ok: true });
  }

  // POST /api/notifications/read-all — mark all as read
  if (path === "/api/notifications/read-all" && method === "POST") {
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return jsonResponse({ error: "Unauthorized" }, 401);
    const adminSession = await env.criahub_db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").bind("session_" + token).first();
    if (!adminSession) {
      const user = await resolveSaaSUser(token);
      if (!user) return jsonResponse({ error: "Invalid session" }, 401);
      // Mark all user's notifications as read
      await env.criahub_db.prepare("UPDATE user_notifications SET read = 1 WHERE user_id = ?").bind(user.id).run();
    }
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Not found" }, 404);
}

// ============================================================
// WEBHOOK: POST / — recebe eventos da Meta
// ============================================================
async function handleWebhook(request, env) {
  const body = await request.json();
  const ts = new Date().toISOString();
  console.log(`[WEBHOOK ${ts}] event received, entries: ${(body.entry||[]).length}`);

  // Save raw webhook to debug table (always)
  try {
    const snippet = JSON.stringify(body).substring(0, 2000);
    await env.criahub_db.prepare(
      "INSERT INTO webhook_log (received_at, payload_snippet) VALUES (?, ?)"
    ).bind(ts, snippet).run();
  } catch (e) { console.error(`[WEBHOOK] log save failed: ${e.message}`); }

  for (const entry of (body.entry || [])) {
    const entryId = String(entry.id);
    console.log(`[WEBHOOK] entry.id=${entryId}, changes=${(entry.changes||[]).length}, messaging=${(entry.messaging||[]).length}, standby=${(entry.standby||[]).length}`);

    // Try to find account by ig_user_id, page_id, username, or media_id
    let account = await env.criahub_db
      .prepare("SELECT * FROM ig_accounts WHERE ig_user_id = ? AND status = 'connected'")
      .bind(entryId)
      .first();

    if (!account) {
      // Try by page_id (Meta sends Page ID in webhook, not IG User ID)
      account = await env.criahub_db
        .prepare("SELECT * FROM ig_accounts WHERE page_id = ? AND status = 'connected'")
        .bind(entryId)
        .first();
      if (account) console.log(`[WEBHOOK] Found account by page_id: @${account.username}`);
    }

    if (!account) {
      // Try by comment author username
      const entryChanges = entry.changes || [];
      let username = null;
      for (const change of entryChanges) {
        if (change.value && change.value.from && change.value.from.username) {
          username = change.value.from.username;
          break;
        }
      }
      if (username) {
        account = await env.criahub_db
          .prepare("SELECT * FROM ig_accounts WHERE LOWER(username) = LOWER(?) AND status = 'connected'")
          .bind(username)
          .first();
        if (account) console.log(`[WEBHOOK] Found account by username: @${account.username}`);
      }
    }

    if (!account) {
      // Try by media_id through campaigns (for comments)
      for (const change of (entry.changes || [])) {
        if (change.value && change.value.media && change.value.media.id) {
          account = await env.criahub_db
            .prepare("SELECT a.* FROM ig_accounts a INNER JOIN campaigns c ON c.ig_account_id = a.id WHERE c.media_id = ? AND a.status = 'connected' LIMIT 1")
            .bind(String(change.value.media.id))
            .first();
          if (account) {
            console.log(`[WEBHOOK] Found account by media_id ${change.value.media.id}: @${account.username}`);
            // Store page_id for future lookups
            try {
              await env.criahub_db.prepare("UPDATE ig_accounts SET page_id = ? WHERE id = ?").bind(entryId, account.id).run();
              console.log(`[WEBHOOK] Stored page_id ${entryId} for @${account.username}`);
            } catch(_) {}
            break;
          }
        }
      }
    }

    if (!account) {
      // Try by sender_id through contacts (for messages/DMs)
      const firstMsg = (entry.messaging || [])[0] || (entry.standby || [])[0];
      if (firstMsg && firstMsg.sender && firstMsg.sender.id) {
        const senderId = String(firstMsg.sender.id);
        account = await env.criahub_db
          .prepare("SELECT a.* FROM ig_accounts a INNER JOIN contacts c ON c.ig_account_id = a.id WHERE c.igsid = ? AND a.status = 'connected' LIMIT 1")
          .bind(senderId)
          .first();
        if (account) console.log(`[WEBHOOK] Found account by sender contact: @${account.username}`);
      }
    }

    if (!account) {
      // Last resort: if only one connected account, use it
      const allAccounts = await env.criahub_db
        .prepare("SELECT * FROM ig_accounts WHERE status = 'connected'")
        .all();
      const accounts = allAccounts.results || [];
      if (accounts.length === 1) {
        account = accounts[0];
        console.log(`[WEBHOOK] Using only connected account: @${account.username}`);
        // Store page_id for future lookups
        try {
          await env.criahub_db.prepare("UPDATE ig_accounts SET page_id = ? WHERE id = ?").bind(entryId, account.id).run();
        } catch(_) {}
      }
    }

    if (!account) {
      console.log(`[WEBHOOK] No account found for entry ${entryId}; skipping`);
      continue;
    }

    console.log(`[WEBHOOK] Account matched: @${account.username} (${account.ig_user_id}, page: ${account.page_id || 'none'})`);

    const token = account.access_token;
    const igUserId = account.ig_user_id;

    // Process comments (changes with field "comments")
    for (const change of (entry.changes || [])) {
      console.log(`[WEBHOOK] change.field=${change.field}`);
      if (change.field === "comments") {
        await handleComment(change.value, igUserId, token, env);
      }
    }

    // Process messages (messaging array)
    for (const msg of (entry.messaging || [])) {
      console.log(`[WEBHOOK] messaging event from ${msg.sender?.id} to ${msg.recipient?.id}`);
      if (msg.message && msg.message.is_echo) continue;
      await handleMessage(msg, igUserId, token, env);
    }

    // Process standby messages
    for (const msg of (entry.standby || [])) {
      console.log(`[WEBHOOK] standby event from ${msg.sender?.id}`);
      if (msg.message && msg.message.is_echo) continue;
      await handleMessage(msg, igUserId, token, env);
    }
  }

  return textResponse("EVENT_RECEIVED", 200);
}

// ============================================================
// COMMENT EVENT handler — responds to ANY comment
// ============================================================
async function handleComment(value, igUserId, token, env) {
  const commentId = value.id;
  const text = (value.text || "").toLowerCase().trim();
  const from = value.from;
  if (!from || !from.id) return;

  const igsid = String(from.id);
  const username = from.username || null;

  // Dedup
  const processed = await env.criahub_db
    .prepare("SELECT 1 FROM processed_events WHERE event_id = ?")
    .bind(commentId)
    .first();
  if (processed) return;

  // Log activity
  try {
    const account = await env.criahub_db.prepare("SELECT id FROM ig_accounts WHERE ig_user_id = ?").bind(igUserId).first();
    if (account) {
      await env.criahub_db.prepare(`
        INSERT INTO activity_log (ig_account_id, event_type, event_detail, status)
        VALUES (?, 'comment_received', ?, 'success')
      `).bind(account.id, `@${username || '?'}: "${text.substring(0, 100)}"`).run();
    }
  } catch (_) {}

  // Upsert contact
  let contactId;
  const existingContact = await env.criahub_db
    .prepare("SELECT id FROM contacts WHERE ig_account_id = (SELECT id FROM ig_accounts WHERE ig_user_id = ?) AND igsid = ?")
    .bind(igUserId, igsid)
    .first();

  if (existingContact) {
    contactId = existingContact.id;
    await env.criahub_db
      .prepare("UPDATE contacts SET last_seen_at = datetime('now'), username = COALESCE(NULLIF(?, ''), username) WHERE id = ?")
      .bind(username, contactId).run();
  } else {
    contactId = "con_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.criahub_db
      .prepare("INSERT INTO contacts (id, ig_account_id, igsid, username, first_seen_at, last_seen_at) VALUES (?, (SELECT id FROM ig_accounts WHERE ig_user_id = ?), ?, ?, datetime('now'), datetime('now'))")
      .bind(contactId, igUserId, igsid, username).run();
  }

  // Find active campaigns for this account
  const campaigns = await env.criahub_db
    .prepare("SELECT c.* FROM campaigns c INNER JOIN ig_accounts a ON c.ig_account_id = a.id WHERE a.ig_user_id = ? AND c.status = 'active'")
    .bind(igUserId).all();
  const campaignList = campaigns.results || [];

  // Fetch post caption for AI context
  let postCaption = null;
  const firstCampaign = campaignList[0];
  if (firstCampaign && firstCampaign.media_id) {
    try {
      const mediaRes = await fetch(`https://graph.instagram.com/${firstCampaign.media_id}?fields=caption&access_token=${token}`);
      const mediaData = await mediaRes.json();
      postCaption = mediaData.caption || null;
    } catch (_) {}
  }

  // Find matching campaign by keyword (optional — any comment triggers response)
  let matchedCampaign = null;
  for (const campaign of campaignList) {
    if (text.includes(campaign.keyword.toLowerCase())) {
      matchedCampaign = campaign;
      break;
    }
  }
  // If no keyword match, use first active campaign
  if (!matchedCampaign && campaignList.length > 0) {
    matchedCampaign = campaignList[0];
  }

  // === STEP 1: PUBLIC REPLY (visible to everyone) ===
  const publicReply = await generateCommentReply(text, postCaption, matchedCampaign?.delivery_content || "o conteudo", env);
  if (publicReply) {
    // Fetch page_access_token for comment reply via graph.facebook.com
    let pageAccessToken = null;
    try {
      const accRow = await env.criahub_db.prepare("SELECT page_access_token FROM ig_accounts WHERE ig_user_id = ?").bind(igUserId).first();
      pageAccessToken = accRow?.page_access_token || null;
    } catch (_) {}
    const replyOk = await postPublicReply(commentId, publicReply, token, pageAccessToken);
    try {
      const acc = await env.criahub_db.prepare("SELECT id FROM ig_accounts WHERE ig_user_id = ?").bind(igUserId).first();
      if (acc) {
        await env.criahub_db.prepare(`INSERT INTO activity_log (ig_account_id, event_type, event_detail, status) VALUES (?, 'comment_reply', ?, ?)`)
          .bind(acc.id, `Reply to @${username || '?'}: "${publicReply.substring(0, 80)}"`, replyOk ? 'success' : 'failed').run();
      }
    } catch (_) {}
  }

  // === STEP 2: CHECK IF ALREADY DELIVERED ===
  let alreadyDelivered = false;
  if (matchedCampaign) {
    const existingState = await env.criahub_db
      .prepare("SELECT stage FROM conversation_state WHERE contact_id = ? AND campaign_id = ?")
      .bind(contactId, matchedCampaign.id).first();
    if (existingState && existingState.stage === 'entregue') {
      alreadyDelivered = true;
    }
  }

  // === STEP 3: DM with rich format (any comment triggers DM) ===
  if (matchedCampaign) {
    if (alreadyDelivered) {
      // Already delivered — send a short thank-you DM instead of full flow
      const thankMsg = `Obrigado pelo teu comentario! Ja enviámos o conteudo anteriormente no direct. Se precisares de mais alguma coisa, e so dizer!`;
      await sendDMRich(igsid, thankMsg, [], token);
      try {
        const acc = await env.criahub_db.prepare("SELECT id FROM ig_accounts WHERE ig_user_id = ?").bind(igUserId).first();
        if (acc) {
          await env.criahub_db.prepare(`INSERT INTO activity_log (ig_account_id, contact_id, campaign_id, event_type, event_detail, status) VALUES (?, ?, ?, 'dm_sent', ?, 'success')`)
            .bind(acc.id, contactId, matchedCampaign.id, `Thank-you DM to @${username || '?'}`).run();
        }
      } catch (_) {}
    } else {
      const isFollower = await checkFollow(igsid, igUserId, token);
      const deliveryContent = matchedCampaign.delivery_content || "o conteudo que solicitaste";
      const campaignKeyword = matchedCampaign.keyword || "QUERO";

      if (isFollower) {
        // Follower — send rich DM with quick reply buttons
        let dmText;
        const aiDm = await generateDMMessage("intro", postCaption, { keyword: campaignKeyword, delivery_content: deliveryContent }, null, env);
        if (aiDm) {
          dmText = aiDm;
        } else {
          dmText = `Ola ${username || ''}! Obrigado pelo teu interesse!\n\n${deliveryContent}\n\nClica num botao abaixo:`;
        }
        const buttons = [
          { title: "Quero Receber", payload: "QUERO" },
          { title: "Nao Quero Mais", payload: "CANCELAR" }
        ];
        await sendDMRich(igsid, dmText, buttons, token);

        // Set conversation state
        await env.criahub_db
          .prepare("INSERT OR IGNORE INTO conversation_state (contact_id, campaign_id, stage) VALUES (?, ?, 'aguardando_quero')")
          .bind(contactId, matchedCampaign.id).run();

        // Log
        try {
          const acc = await env.criahub_db.prepare("SELECT id FROM ig_accounts WHERE ig_user_id = ?").bind(igUserId).first();
          if (acc) {
            await env.criahub_db.prepare(`INSERT INTO activity_log (ig_account_id, contact_id, campaign_id, event_type, event_detail, status) VALUES (?, ?, ?, 'dm_sent', ?, 'success')`)
              .bind(acc.id, contactId, matchedCampaign.id, `Rich DM to @${username || '?'}: "${dmText.substring(0, 80)}..."`).run();
          }
        } catch (_) {}
      } else {
        // Not a follower — ask to follow with buttons
        const followMsg = `Ola ${username || ''}! Obrigado pelo comentario!\n\nPara receberes "${deliveryContent}", precisamos que nos sigas primeiro!\n\nDepois de seguir, clica no botao.`;
        const buttons = [
          { title: "Ja Segui!", payload: "SEGUI" },
          { title: "Nao Quero Mais", payload: "CANCELAR" }
        ];
        await sendDMRich(igsid, followMsg, buttons, token);

        await env.criahub_db
          .prepare("INSERT OR IGNORE INTO conversation_state (contact_id, campaign_id, stage) VALUES (?, ?, 'aguardando_follow')")
          .bind(contactId, matchedCampaign.id).run();
      }
    }
  }

  // Mark processed
  try { await env.criahub_db.prepare("INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)").bind(commentId).run(); } catch (_) {}
}

// ============================================================
// MESSAGE EVENT handler — follow-gate logic
// ============================================================
async function handleMessage(msg, igUserId, token, env) {
  const senderId = msg.sender ? msg.sender.id : (msg.sender_id || null);
  if (!senderId || String(senderId) === igUserId) return;

  const igsid = String(senderId);
  const rawText = (msg.message ? msg.message.text : "").toLowerCase().trim();
  // Quick reply button payload takes priority over text
  const payload = (msg.message && msg.message.quick_reply && msg.message.quick_reply.payload)
    ? msg.message.quick_reply.payload.toLowerCase().trim()
    : "";
  const text = payload || rawText;
  const messageId = msg.message ? (msg.message.mid || msg.message.message_id) : null;

  console.log(`[DM] From ${igsid}: text="${rawText}" payload="${payload}" resolved="${text}"`);

  // Dedup
  if (messageId) {
    const processed = await env.criahub_db
      .prepare("SELECT 1 FROM processed_events WHERE event_id = ?")
      .bind(messageId)
      .first();
    if (processed) return;
  }

  // Find contact
  const contact = await env.criahub_db
    .prepare("SELECT id FROM contacts WHERE ig_account_id = (SELECT id FROM ig_accounts WHERE ig_user_id = ?) AND igsid = ?")
    .bind(igUserId, igsid)
    .first();

  if (!contact) {
    console.log(`[DM] Message from unknown contact ${igsid}, skipping`);
    return;
  }

  // Helper: deliver content to contact
  async function deliverContent(conv) {
    let postCaption = null;
    if (conv.media_id) {
      try {
        const mediaRes = await fetch(`https://graph.instagram.com/${conv.media_id}?fields=caption&access_token=${token}`);
        const mediaData = await mediaRes.json();
        postCaption = mediaData.caption || null;
      } catch (_) {}
    }

    const following = await checkFollow(igsid, igUserId, token);
    if (following) {
      let deliveryMsg = conv.delivery_content;
      const aiDelivery = await generateDMMessage("entrega", postCaption, conv, null, env);
      if (aiDelivery) deliveryMsg = aiDelivery + "\n\n" + conv.delivery_content;
      await sendDM(igsid, deliveryMsg, token);
      await env.criahub_db
        .prepare("UPDATE conversation_state SET stage = 'entregue', updated_at = datetime('now') WHERE contact_id = ? AND campaign_id = ?")
        .bind(contact.id, conv.campaign_id).run();
      console.log(`[DM] Delivered to ${igsid}`);
      return true;
    } else {
      let followMsg = conv.follow_request_message || "Precisas seguir o nosso perfil para receber o conteudo!";
      const aiFollow = await generateDMMessage("follow", postCaption, conv, null, env);
      if (aiFollow) followMsg = aiFollow;
      await sendDM(igsid, followMsg, token);
      await env.criahub_db
        .prepare("UPDATE conversation_state SET stage = 'aguardando_follow', updated_at = datetime('now') WHERE contact_id = ? AND campaign_id = ?")
        .bind(contact.id, conv.campaign_id).run();
      console.log(`[DM] Asked ${igsid} to follow`);
      return false;
    }
  }

  // Get conversation states
  const convStates = await env.criahub_db
    .prepare(`
      SELECT cs.*, cp.keyword, cp.private_reply_message, cp.follow_request_message,
             cp.delivery_content, cp.media_id, cp.id AS campaign_id
      FROM conversation_state cs
      INNER JOIN campaigns cp ON cs.campaign_id = cp.id
      WHERE cs.contact_id = ?
    `)
    .bind(contact.id)
    .all();

  let handled = false;

  for (const conv of (convStates.results || [])) {
    if (conv.stage === "entregue") continue;

    // Handle CANCELAR button — user doesn't want the content
    if (text === "cancelar" || text === "nao quero mais" || text === "não quero mais") {
      await env.criahub_db
        .prepare("UPDATE conversation_state SET stage = 'cancelado', updated_at = datetime('now') WHERE contact_id = ? AND campaign_id = ?")
        .bind(contact.id, conv.campaign_id).run();
      await sendDM(igsid, "Sem problemas! Se mudares de ideias, e so comentares novamente no post. Ate breve! 👋", token);
      console.log(`[DM] User ${igsid} cancelled campaign ${conv.campaign_id}`);
      handled = true;
      break;
    }

    // Build accepted keywords: hardcoded + campaign keyword
    const campaignKw = (conv.keyword || "").toLowerCase().trim();
    const queroKeywords = ["quero", "receber agora", "saber mais", "quero receber", "sim", "info", "quero receber"];
    const followKeywords = ["pronto", "sim", "ok", "ja segui", "segui", "feito", "quero", "ja segui!", "perfil", "seguir", "segui!"];

    if (campaignKw && !queroKeywords.includes(campaignKw)) {
      queroKeywords.push(campaignKw);
    }

    if (conv.stage === "aguardando_quero") {
      if (queroKeywords.includes(text) || (campaignKw && text.includes(campaignKw))) {
        await deliverContent(conv);
        handled = true;
        break;
      }
    } else if (conv.stage === "aguardando_follow") {
      if (followKeywords.includes(text) || text === campaignKw) {
        const delivered = await deliverContent(conv);
        handled = true;
        if (!delivered) break; // still not following, stop
        break;
      }
    }
  }

  // If no conversation state matched but user typed a campaign keyword, start fresh flow
  if (!handled && text) {
    const campaigns = await env.criahub_db
      .prepare("SELECT c.* FROM campaigns c INNER JOIN ig_accounts a ON c.ig_account_id = a.id WHERE a.ig_user_id = ? AND c.status = 'active'")
      .bind(igUserId).all();

    for (const campaign of (campaigns.results || [])) {
      const kw = (campaign.keyword || "").toLowerCase().trim();
      if (kw && (text === kw || text.includes(kw))) {
        // Check if already has active conversation for this campaign
        const existing = await env.criahub_db
          .prepare("SELECT stage FROM conversation_state WHERE contact_id = ? AND campaign_id = ? AND stage != 'entregue'")
          .bind(contact.id, campaign.id).first();
        if (!existing) {
          // Start new flow via DM
          const isFollower = await checkFollow(igsid, igUserId, token);
          if (isFollower) {
            await env.criahub_db
              .prepare("INSERT OR IGNORE INTO conversation_state (contact_id, campaign_id, stage) VALUES (?, ?, 'aguardando_quero')")
              .bind(contact.id, campaign.id).run();
            // Re-trigger delivery
            const conv = { ...campaign, campaign_id: campaign.id };
            await deliverContent(conv);
            handled = true;
            break;
          }
        }
      }
    }
  }

  // Mark message processed
  if (messageId) {
    try {
      await env.criahub_db
        .prepare("INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)")
        .bind(messageId)
        .run();
    } catch (_) {}
  }
}
// ============================================================
// sendDM — envia mensagem no direct
// ============================================================
async function sendDM(recipientId, text, token) {
  try {
    const res = await fetch(`${IG_GRAPH_BASE}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: text },
        access_token: token
      })
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`DM sent to ${recipientId}: ${text.substring(0, 40)}`);
      return true;
    } else {
      console.error(`DM failed: ${JSON.stringify(data)}`);
      return false;
    }
  } catch (err) {
    console.error(`DM exception: ${err.message}`);
    return false;
  }
}

// ============================================================
// sendDMRich — DM with quick reply buttons (better than ManyChat)
// ============================================================
async function sendDMRich(recipientId, text, quickReplies, token) {
  try {
    const message = { text: text };
    if (quickReplies && quickReplies.length > 0) {
      message.quick_replies = quickReplies.map(btn => ({
        content_type: "text",
        title: btn.title,
        payload: btn.payload
      }));
    }
    const res = await fetch(`${IG_GRAPH_BASE}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: message,
        access_token: token
      })
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`Rich DM sent to ${recipientId}: ${text.substring(0, 40)}`);
      return true;
    } else {
      console.error(`Rich DM failed: ${JSON.stringify(data)}`);
      return false;
    }
  } catch (err) {
    console.error(`Rich DM exception: ${err.message}`);
    return false;
  }
}

// ============================================================
// postPublicReply — reply publicly to a comment
// ============================================================
async function postPublicReply(commentId, text, token, pageAccessToken) {
  try {
    // Prefer Page Access Token for graph.facebook.com comment replies
    const fbToken = pageAccessToken || token;
    const url = `https://graph.facebook.com/v21.0/${commentId}/replies?access_token=${fbToken}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text })
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`[COMMENT_REPLY] Success for comment ${commentId}`);
      return true;
    } else {
      console.error(`[COMMENT_REPLY] Failed (code: ${data.error?.code}, type: ${data.error?.type}, msg: ${data.error?.message})`);
      return false;
    }
  } catch (err) {
    console.error(`[COMMENT_REPLY] Exception: ${err.message}`);
    return false;
  }
}

// ============================================================
// checkFollow — is_user_follow_business via Instagram Graph
// ============================================================
async function checkFollow(igsid, igUserId, token) {
  try {
    const url = `${IG_GRAPH_BASE}/${igsid}?fields=is_user_follow_business&access_token=${token}`;
    const res = await fetch(url);
    const data = await res.json();
    console.log(`checkFollow ${igsid} -> ${igUserId}: ${JSON.stringify(data)}`);
    if (res.ok && data.is_user_follow_business !== undefined) {
      return data.is_user_follow_business === true;
    }
    console.error(`checkFollow error: ${JSON.stringify(data)}`);
    return false;
  } catch (err) {
    console.error(`checkFollow exception: ${err.message}`);
    return false;
  }
}

// ============================================================
// GROQ AI — Gerar respostas inteligentes (PT-PT)
// ============================================================
async function getGroqApiKey(env) {
  if (env.GROQ_API_KEY) return env.GROQ_API_KEY;
  try {
    const row = await env.criahub_db.prepare("SELECT value FROM system_config WHERE key = 'groq_api_key'").first();
    return row ? row.value : null;
  } catch (_) { return null; }
}

async function groqChat(messages, env) {
  const apiKey = await getGroqApiKey(env);
  if (!apiKey) return null;
  try {
    const cfg = await env.criahub_db.prepare("SELECT value FROM system_config WHERE key = 'ai_enabled'").first();
    if (cfg && cfg.value === '0') return null;
  } catch (_) {}
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: messages,
        temperature: 0.85,
        max_tokens: 250
      })
    });
    const data = await res.json();
    if (res.ok && data.choices && data.choices[0]) {
      return data.choices[0].message.content.trim();
    }
    console.error("Groq error:", JSON.stringify(data));
    return null;
  } catch (err) {
    console.error("Groq exception:", err.message);
    return null;
  }
}

async function detectCommentIntent(commentText, availableKeywords, env) {
  if (!availableKeywords.length) return null;
  const systemMsg = {
    role: "system",
    content: `Analise o comentario e determine a intencao da pessoa. Responda APENAS com a palavra-chave exata de uma das opcoes disponiveis, sem nada mais. Opcoes: [${availableKeywords.map(k => `"${k}"`).join(', ')}]. Regras: Se a pessoa demonstra interesse ou pede algo (ex: "quero", "como", "me manda", "eu quero", "pode mandar", "me manda", "quero acesso"), responda com a palavra-chave mais proxima. Responda SOMENTE com uma palavra-chave da lista. Nao escreva mais nada.`
  };
  const userMsg = {
    role: "user",
    content: `Comentario: "${commentText}"`
  };
  const result = await groqChat([systemMsg, userMsg], env);
  if (!result) return null;
  const cleaned = result.toLowerCase().trim().replace(/["']/g, '').replace(/[^a-záàãâéêíóôõúç\s]/gi, '');
  for (const kw of availableKeywords) {
    if (cleaned.includes(kw.toLowerCase()) || kw.toLowerCase().includes(cleaned)) {
      return kw;
    }
  }
  return null;
}

async function generateCommentReply(commentText, postCaption, deliveryType, env) {
  const typeHint = deliveryType || "o conteudo";
  const prompt = `Responda sempre em portugues de Portugal (PT-PT). Nao use portugues do Brasil. Responda sempre em PT-PT. So use portugues europeu. Responda SEMPRE em portugues europeu. Nao use vocabulario brasileiro. Use "tu" ou "voce" de forma europeia. Responda em portugues de Portugal.`;
  const userMsg = `Post sobre: "${(postCaption || 'marketing digital').substring(0, 200)}"\nComentario da pessoa: "${commentText}"\nTipo de conteudo: "${typeHint}"\n\nResponda ao comentario de forma amigavel, profissional e convincente. Mencione que vai enviar uma mensagem privada (DM) para entregar o conteudo/informacao. Maximo 2-3 linhas. Nao use aspas. Nao use emojis. Use linguagem natural de Portugal.`;
  const result = await groqChat([
    { role: "system", content: prompt },
    { role: "user", content: userMsg }
  ], env);
  return result || null;
}

async function generateDMMessage(stage, postCaption, campaign, convHistory, env) {
  let systemPrompt = "";
  if (stage === "quero") {
    systemPrompt = `Responda sempre em portugues de Portugal (PT-PT). Nao use portugues do Brasil. So use portugues europeu. Responda em portugues de Portugal. A pessoa demonstrou interesse no conteudo. Gere UMA mensagem curta, amigavel e convincente em portugues europeu (maximo 3 linhas). Confirme que vai enviar o conteudo/informacao solicitada. Nao use aspas. Nao use emojis. Seja profissional mas acessivel. Use linguagem natural de Portugal.`;
  } else if (stage === "follow") {
    systemPrompt = `Responda sempre em portugues de Portugal (PT-PT). Nao use portugues do Brasil. So use portugues europeu. Responda em portugues de Portugal. A pessoa precisa seguir o perfil para receber o conteudo. Gere UMA mensagem curta e amigavel em portugues europeu (maximo 3 linhas). Explique de forma gentil porque precisa seguir o perfil. Nao use aspas. Nao use emojis. Seja profissional mas acessivel. Use linguagem natural de Portugal.`;
  } else if (stage === "entrega") {
    systemPrompt = `Responda sempre em portugues de Portugal (PT-PT). Nao use portugues do Brasil. So use portugues europeu. Responda em portugues de Portugal. A pessoa ja cumpriu o que foi pedido. Gere UMA mensagem de entrega em portugues europeu (maximo 2 linhas). Entregue o conteudo/link de forma amigavel e profissional. Nao use aspas. Nao use emojis. Use linguagem natural de Portugal.`;
  } else {
    systemPrompt = `Responda sempre em portugues de Portugal (PT-PT). Nao use portugues do Brasil. So use portugues europeu. Responda em portugues de Portugal. Gere UMA mensagem curta e amigavel em portugues europeu (maximo 3 linhas). Nao use aspas. Nao use emojis. Seja profissional. Use linguagem natural de Portugal.`;
  }
  const userMsg = `Post sobre: "${(postCaption || 'marketing digital').substring(0, 200)}"\nMensagem estatica: "${campaign.private_reply_message || ''}"\nMensagem follow: "${campaign.follow_request_message || ''}"\nConteudo/Link: "${campaign.delivery_content || ''}"`;
  const result = await groqChat([
    { role: "system", content: systemPrompt },
    { role: "user", content: userMsg }
  ], env);
  return result || null;
}

// ============================================================
// AI — Classificacao e Resposta Publica (PT-PT)
// ============================================================

async function classifyComment(commentText, postCaption, env) {
  const systemMsg = {
    role: "system",
    content: `Classifique o comentario do Instagram em APENAS UMA das seguintes categorias. Responda SOMENTE com a categoria, nada mais.

Categorias:
- "aprovado" - Comentario positivo, neutro, pergunta sobre o conteudo, elogio, ou duvida legitima
- "agressivo" - Comentario com tom rude, impaciente, frustracao, mas ainda sobre o tema (sem xingamento direto)
- "ignorar" - Xingamento, xenofobia, racismo, palavrao, comentario maldoso, spam, mencao a concorrentes, ou completamente off-topic

Regras:
- Se a pessoa xinga ou usa linguagem ofensiva → "ignorar"
- Se menciona concorrentes ou pede para ir embora → "ignorar"
- Se e spam ou link suspeito → "ignorar"
- Se e rude mas fala sobre o conteudo (tipo "isso e mentira", "nao acredito") → "agressivo"
- Se e positivo, neutro ou pergunta normal → "aprovado"
- Nao escreva mais nada alem da categoria`
  };
  const userMsg = {
    role: "user",
    content: `Post sobre: "${(postCaption || 'marketing digital').substring(0, 150)}"\nComentario: "${commentText}"`
  };
  const result = await groqChat([systemMsg, userMsg], env);
  if (!result) return "aprovado";
  const cleaned = result.toLowerCase().trim().replace(/["']/g, '');
  if (cleaned.includes("ignorar")) return "ignorar";
  if (cleaned.includes("agressivo")) return "agressivo";
  return "aprovado";
}

async function generatePublicReply(commentText, postCaption, classification, env) {
  let prompt = "";
  if (classification === "agressivo") {
    prompt = `Responda sempre em portugues de Portugal (PT-PT). Nao use portugues do Brasil. So use portugues europeu. Responda em portugues de Portugal. A pessoa fez um comentario com tom agressivo ou de duvida sobre o conteudo. Responda de forma MUITO educada, profissional e gentil. Demonstre que entendemos a frustracao e que estamos aqui para ajudar. Nao seja defensivo. Maximo 2-3 linhas. Nao use aspas. Nao use emojis. Use linguagem natural de Portugal.`;
  } else {
    prompt = `Responda sempre em portugues de Portugal (PT-PT). Nao use portugues do Brasil. So use portugues europeu. Responda em portugues de Portugal. Alguem comentou num post do Instagram. Responda de forma profissional, amigavel e carinhosa. Agradeca o comentario e seja breve. Maximo 2 linhas. Nao use aspas. Nao use emojis. Use linguagem natural de Portugal. Fale apenas sobre o assunto do post.`;
  }
  const userMsg = `Post sobre: "${(postCaption || 'marketing digital').substring(0, 200)}"\nComentario: "${commentText}"`;
  const result = await groqChat([
    { role: "system", content: prompt },
    { role: "user", content: userMsg }
  ], env);
  return result || null;
}

// ============================================================
// ADMIN: create campaign
// ------------------------------------------------------------
async function handleCreateCampaign(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return textResponse("Unauthorized", 401);
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.ig_user_id || !body.keyword) {
    return jsonResponse({ error: "ig_user_id and keyword required" }, 400);
  }

  const account = await env.criahub_db
    .prepare("SELECT id FROM ig_accounts WHERE ig_user_id = ? AND status = 'connected'")
    .bind(body.ig_user_id)
    .first();

  if (!account) return jsonResponse({ error: "Account not found" }, 404);

  const id = "cmp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await env.criahub_db
    .prepare(`
      INSERT INTO campaigns (id, ig_account_id, keyword, private_reply_message, follow_request_message, delivery_content, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'))
    `)
    .bind(
      id,
      account.id,
      body.keyword,
      body.private_reply_message || "Recebemos seu comentário! Responda QUERO aqui para receber o conteúdo.",
      body.follow_request_message || "Você precisa me seguir para receber. Segue e responde PRONTO.",
      body.delivery_content || "www.criahub.global"
    )
    .run();

  return jsonResponse({ campaign_id: id, message: "Campanha criada" });
}

// ------------------------------------------------------------
// ADMIN: activate automation for an account
// ------------------------------------------------------------
async function handleActivateAutomation(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return textResponse("Unauthorized", 401);
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.ig_user_id) {
    return jsonResponse({ error: "ig_user_id required" }, 400);
  }

  const account = await env.criahub_db
    .prepare("SELECT * FROM ig_accounts WHERE ig_user_id = ? AND status = 'connected'")
    .bind(body.ig_user_id)
    .first();

  if (!account) return jsonResponse({ error: "Account not connected" }, 404);

  const keyword = body.keyword || "ACESSO";
  const replyMsg = body.private_reply_message || "Recebemos seu comentário! Se quiser o conteúdo, responda QUERO aqui.";
  const followMsg = body.follow_request_message || "Você precisa me seguir para receber o conteúdo. Segue e responde PRONTO.";
  const content = body.delivery_content || "www.criahub.global";

  const existing = await env.criahub_db
    .prepare("SELECT id FROM campaigns WHERE ig_account_id = ? AND keyword = ?")
    .bind(account.id, keyword)
    .first();

  let campId;
  if (existing) {
    campId = existing.id;
    await env.criahub_db
      .prepare("UPDATE campaigns SET private_reply_message = ?, follow_request_message = ?, delivery_content = ?, status = 'active' WHERE id = ?")
      .bind(replyMsg, followMsg, content, campId)
      .run();
  } else {
    campId = "cmp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.criahub_db
      .prepare("INSERT INTO campaigns (id, ig_account_id, keyword, private_reply_message, follow_request_message, delivery_content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'))")
      .bind(campId, account.id, keyword, replyMsg, followMsg, content)
      .run();
  }

  return jsonResponse({
    campaign_id: campId,
    keyword: keyword,
    message: `Automação ativada para @${account.username} com palavra-chave "${keyword}"`
  });
}

// ------------------------------------------------------------
// ADMIN: list accounts
// ------------------------------------------------------------
async function handleAdminAccounts(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return textResponse("Unauthorized", 401);
  }

  const accounts = await env.criahub_db
    .prepare("SELECT id, ig_user_id, username, status, token_expires_at FROM ig_accounts ORDER BY connected_at DESC")
    .all();

  return jsonResponse(accounts.results || []);
}

// ------------------------------------------------------------
// GET /connect?client=ID — redireciona pro Instagram OAuth
// ------------------------------------------------------------
async function handleConnect(url, env) {
  const clientId = url.searchParams.get("client");
  if (!clientId) {
    return textResponse("Parâmetro 'client' é obrigatório.", 400);
  }

  const client = await env.criahub_db
    .prepare("SELECT id FROM clients WHERE id = ?")
    .bind(clientId)
    .first();

  if (!client) {
    return textResponse("Cliente não encontrado.", 404);
  }

  const state = await signState(env, { client_id: clientId, nonce: crypto.randomUUID() });
  const redirectUri = `${url.origin}/oauth/callback`;
  console.log("DEBUG [connect] redirect_uri enviado:", JSON.stringify(redirectUri));

  const authorizeUrl = new URL(IG_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", env.IG_APP_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", IG_SCOPES);
  authorizeUrl.searchParams.set("state", state);

  return Response.redirect(authorizeUrl.toString(), 302);
}

// ------------------------------------------------------------
// GET /oauth/callback — troca o code por token e salva a conta
// ------------------------------------------------------------
async function handleOAuthCallback(url, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    return textResponse(`O Instagram retornou um erro: ${errorParam}. Tente novamente.`, 400);
  }
  if (!code || !state) {
    return textResponse("Parâmetros 'code' ou 'state' ausentes.", 400);
  }

  const statePayload = await verifyState(env, state);
  if (!statePayload) {
    return textResponse("State inválido ou expirado. Peça um novo link de conexão.", 400);
  }

  const clientId = statePayload.client_id;
  const redirectUri = `${url.origin}/oauth/callback`;
  console.log("DEBUG [callback] redirect_uri enviado:", JSON.stringify(redirectUri));

  console.log("DEBUG [callback] Aguardando 3s antes de trocar o code (teste de race condition)...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 1) Trocar o "code" por um token de curta duração
  // IMPORTANTE: a Meta exige multipart/form-data aqui (não urlencoded) —
  // por isso usamos FormData em vez de URLSearchParams no body.
  const shortTokenForm = new FormData();
  shortTokenForm.set("client_id", env.IG_APP_ID);
  shortTokenForm.set("client_secret", env.IG_APP_SECRET);
  shortTokenForm.set("grant_type", "authorization_code");
  shortTokenForm.set("redirect_uri", redirectUri);
  shortTokenForm.set("code", code);

  const shortTokenRes = await fetch(IG_TOKEN_URL, {
    method: "POST",
    body: shortTokenForm,
  });
  const shortTokenRaw = await shortTokenRes.json();
  console.log("DEBUG [callback] resposta bruta do token curto:", JSON.stringify(shortTokenRaw));

  // A resposta de sucesso vem como { data: [ { access_token, user_id, permissions } ] }
  const shortTokenData = Array.isArray(shortTokenRaw.data) ? shortTokenRaw.data[0] : shortTokenRaw;

  if (!shortTokenRes.ok || !shortTokenData || !shortTokenData.access_token) {
    console.error("Falha ao trocar code por token curto:", JSON.stringify(shortTokenRaw));
    return textResponse("Falha ao autorizar com o Instagram. Tente novamente.", 400);
  }

  const shortLivedToken = shortTokenData.access_token;
  const igUserId = String(shortTokenData.user_id);

  // 2) Trocar o token de curta duração por um de longa duração (60 dias)
  const exchangeUrl = new URL(`${IG_GRAPH_BASE}/access_token`);
  exchangeUrl.searchParams.set("grant_type", "ig_exchange_token");
  exchangeUrl.searchParams.set("client_secret", env.IG_APP_SECRET);
  exchangeUrl.searchParams.set("access_token", shortLivedToken);

  const longTokenRes = await fetch(exchangeUrl.toString());
  const longTokenData = await longTokenRes.json();

  if (!longTokenRes.ok || !longTokenData.access_token) {
    console.error("Falha ao trocar por token longo:", JSON.stringify(longTokenData));
    return textResponse("Falha ao gerar token de longa duração. Tente novamente.", 400);
  }

  const longLivedToken = longTokenData.access_token;
  const expiresInSeconds = longTokenData.expires_in || 60 * 24 * 60 * 60; // fallback ~60 dias
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  // 3) Buscar o username da conta
  const profileUrl = new URL(`${IG_GRAPH_BASE}/me`);
  profileUrl.searchParams.set("fields", "id,username");
  profileUrl.searchParams.set("access_token", longLivedToken);

  const profileRes = await fetch(profileUrl.toString());
  const profileData = await profileRes.json();
  const username = profileData.username || null;

  // 3b) Try to get Page Access Token (needed for comment replies)
  let finalToken = longLivedToken;
  let detectedPageId = null;
  try {
    const pagesRes = await fetch(`https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token&access_token=${longLivedToken}`);
    const pagesData = await pagesRes.json();
    if (pagesRes.ok && pagesData.data && pagesData.data.length > 0) {
      finalToken = pagesData.data[0].access_token;
      detectedPageId = pagesData.data[0].id;
      console.log(`[OAUTH] Got Page Access Token for page: ${pagesData.data[0].name} (id: ${detectedPageId})`);
    }
  } catch (e) {
    console.log(`[OAUTH] Could not get Page token, using user token: ${e.message}`);
  }

  // 4) Salvar (ou atualizar) a conta conectada no banco
  const igAccountId = "ig_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  await env.criahub_db
    .prepare(
      `INSERT INTO ig_accounts (id, client_id, ig_user_id, username, access_token, token_expires_at, status, page_id)
       VALUES (?, ?, ?, ?, ?, ?, 'connected', ?)
       ON CONFLICT(ig_user_id) DO UPDATE SET
         client_id = excluded.client_id,
         username = excluded.username,
         access_token = excluded.access_token,
         token_expires_at = excluded.token_expires_at,
         status = 'connected',
         page_id = COALESCE(excluded.page_id, ig_accounts.page_id)`
    )
    .bind(igAccountId, clientId, igUserId, username, finalToken, expiresAt, detectedPageId)
    .run();

  return htmlResponse(`
    <h2>Conta conectada com sucesso!</h2>
    <p>A conta <strong>@${escapeHtml(username || igUserId)}</strong> foi conectada à automação.</p>
    <p>Você já pode fechar esta janela.</p>
  `);
}

// ------------------------------------------------------------
// FACEBOOK OAUTH — /fb/connect e /fb/callback
// (Obtém Page Access Token para comment replies via graph.facebook.com)
// ------------------------------------------------------------
async function handleFBConnect(url, env) {
  const igUserId = url.searchParams.get("ig_user_id");
  if (!igUserId) {
    return textResponse("Parâmetro 'ig_user_id' obrigatório.", 400);
  }

  const state = await signState(env, { ig_user_id: igUserId, nonce: crypto.randomUUID() });
  const redirectUri = `${url.origin}/fb/callback`;

  const fbAuthUrl = new URL("https://www.facebook.com/v21.0/dialog/oauth");
  fbAuthUrl.searchParams.set("client_id", env.IG_APP_ID);
  fbAuthUrl.searchParams.set("redirect_uri", redirectUri);
  fbAuthUrl.searchParams.set("scope", "instagram_manage_comments,instagram_manage_messages,pages_show_list,pages_read_engagement");
  fbAuthUrl.searchParams.set("state", state);
  fbAuthUrl.searchParams.set("response_type", "code");

  return Response.redirect(fbAuthUrl.toString(), 302);
}

async function handleFBCallback(url, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return textResponse("Parâmetros ausentes.", 400);

  const statePayload = await verifyState(env, state);
  if (!statePayload) return textResponse("State inválido ou expirado.", 400);

  const igUserId = statePayload.ig_user_id;
  const redirectUri = `${url.origin}/fb/callback`;

  // 1) Exchange code for short-lived token
  const tokenRes = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?client_id=${env.IG_APP_ID}&client_secret=${env.IG_APP_SECRET}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`);
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    console.error("[FB_OAUTH] Token exchange failed:", JSON.stringify(tokenData));
    return textResponse("Falha ao obter token do Facebook.", 400);
  }

  // 2) Exchange for long-lived token
  const llRes = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${env.IG_APP_ID}&client_secret=${env.IG_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`);
  const llData = await llRes.json();
  const longToken = llData.access_token || tokenData.access_token;
  console.log("[FB_OAUTH] Long-lived token obtained:", longToken.substring(0, 20) + "...");

  // 3) Get Pages and their access tokens
  const pagesRes = await fetch(`https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token&access_token=${longToken}`);
  const pagesData = await pagesRes.json();
  console.log("[FB_OAUTH] Pages:", JSON.stringify(pagesData.data?.map(p => ({ id: p.id, name: p.name })) || []));

  if (pagesData.data && pagesData.data.length > 0) {
    const pageToken = pagesData.data[0].access_token;
    const pageId = pagesData.data[0].id;
    const pageName = pagesData.data[0].name;

    // Store page_access_token + page_id for this IG account
    await env.criahub_db.prepare(
      `UPDATE ig_accounts SET page_access_token = ?, page_id = ? WHERE ig_user_id = ?`
    ).bind(pageToken, pageId, igUserId).run();

    console.log(`[FB_OAUTH] Saved page token for @${igUserId} — page: ${pageName} (${pageId})`);

    return htmlResponse(`
      <h2>Facebook Page conectado!</h2>
      <p>Página: <strong>${escapeHtml(pageName)}</strong> (${pageId})</p>
      <p>Agora replies a comentários devem funcionar. Pode fechar esta janela.</p>
    `);
  }

  return textResponse("Nenhuma Página Facebook encontrada. Certifica-se de ter uma Página associada à tua conta Instagram.", 400);
}

// ------------------------------------------------------------
// TIKTOK OAuth — /tiktok/connect e /tiktok/callback
// ------------------------------------------------------------
async function handleTikTokConnect(url, env) {
  if (!env.TIKTOK_CLIENT_KEY) {
    return textResponse("TikTok OAuth não configurado. Adicione TIKTOK_CLIENT_KEY no Cloudflare.", 400);
  }

  // session_token from query (admin or SaaS user)
  const sessionToken = url.searchParams.get("session") || "";
  const sessionKey = sessionToken.startsWith("user_") ? "session_user_" + sessionToken.replace("user_", "") : "session_" + sessionToken;
  const session = await env.criahub_db.prepare("SELECT value FROM system_config WHERE key = ?").bind(sessionKey).first();
  if (!session && !sessionToken.startsWith("admin")) {
    return textResponse("Sessão inválida. Faça login novamente.", 401);
  }
  const userId = session?.value || sessionToken;

  const state = await signState(env, { user_id: userId, session_token: sessionToken, nonce: crypto.randomUUID() });
  const redirectUri = `${url.origin}/tiktok/callback`;

  const authorizeUrl = new URL(TIKTOK_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_key", env.TIKTOK_CLIENT_KEY);
  authorizeUrl.searchParams.set("scope", TIKTOK_SCOPES);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);

  return Response.redirect(authorizeUrl.toString(), 302);
}

async function handleTikTokCallback(url, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    return textResponse(`O TikTok retornou um erro: ${errorParam}. Tente novamente.`, 400);
  }
  if (!code || !state) {
    return textResponse("Parâmetros 'code' ou 'state' ausentes.", 400);
  }

  const statePayload = await verifyState(env, state);
  if (!statePayload) {
    return textResponse("State inválido ou expirado. Peça um novo link de conexão.", 400);
  }

  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
    return textResponse("TikTok OAuth não configurado no servidor.", 500);
  }

  const redirectUri = `${url.origin}/tiktok/callback`;

  // 1) Trocar code por access token
  const tokenBody = new URLSearchParams();
  tokenBody.set("client_key", env.TIKTOK_CLIENT_KEY);
  tokenBody.set("client_secret", env.TIKTOK_CLIENT_SECRET);
  tokenBody.set("code", code);
  tokenBody.set("grant_type", "authorization_code");
  tokenBody.set("redirect_uri", redirectUri);

  const tokenRes = await fetch(TIKTOK_TOKEN_URL, {
    method: "POST",
    body: tokenBody,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const tokenData = await tokenRes.json();
  console.log("DEBUG [TikTok callback] token response:", JSON.stringify(tokenData));

  const accessToken = tokenData?.data?.access_token;
  const openId = tokenData?.data?.open_id;
  const refreshToken = tokenData?.data?.refresh_token;
  const expiresIn = tokenData?.data?.expires_in || 86400;
  const scope = tokenData?.data?.scope || "";

  if (!accessToken || !openId) {
    console.error("Falha ao obter token TikTok:", JSON.stringify(tokenData));
    return textResponse("Falha ao autorizar com o TikTok. Verifique as permissões da app.", 400);
  }

  // 2) Buscar info do utilizador
  const userRes = await fetch(`${TIKTOK_API_BASE}/user/info/?fields=display_name,username,avatar_url`, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  const userData = await userRes.json();
  const tiktokUsername = userData?.data?.user?.username || userData?.data?.user?.display_name || openId;
  const tiktokDisplayName = userData?.data?.user?.display_name || tiktokUsername;

  // 3) Salvar no banco
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const userId = statePayload.user_id;

  // Find which user this session belongs to
  let targetUserId = userId;

  await env.criahub_db.prepare(`INSERT OR REPLACE INTO tiktok_configs (user_id, account_id, access_token, refresh_token, token_expires_at, tiktok_username, tiktok_user_id, status, scopes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?, datetime('now'))`)
    .bind(targetUserId, "tt_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), accessToken, refreshToken || null, expiresAt, tiktokUsername, openId, scope)
    .run();

  return htmlResponse(`
    <div style="text-align:center;padding:60px 20px;max-width:500px;margin:0 auto">
      <div style="font-size:64px;margin-bottom:20px">&#127916;</div>
      <h2 style="color:#00c853;margin-bottom:12px">TikTok conectado!</h2>
      <p style="font-size:18px;color:#333">Conta: <strong>@${escapeHtml(tiktokDisplayName)}</strong></p>
      <p style="color:#666;margin-top:20px">Pode fechar esta janela.</p>
    </div>
  `);
}

// ------------------------------------------------------------
// TIKTOK WEBHOOK — Verificação + Receber comentários
// ------------------------------------------------------------
async function handleTikTokWebhookVerify(url, env) {
  // TikTok sends a "challenge" query param for webhook verification
  const challenge = url.searchParams.get("challenge");
  if (challenge) {
    return new Response(challenge, {
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response("OK", { status: 200 });
}

async function handleTikTokWebhook(request, env) {
  try {
    const body = await request.json();
    console.log("[TikTok Webhook] Recebido:", JSON.stringify(body).substring(0, 500));

    // TikTok webhook events
    const event = body?.event;
    if (event === "comment") {
      const comment = body?.comment;
      if (comment) {
        const videoId = comment?.video_id;
        const commentId = comment?.id;
        const text = comment?.text || "";
        const userNickname = comment?.user?.nickname || "Utilizador";
        const userOpenId = comment?.user?.open_id;

        // Find automations matching this video
        const automations = await env.criahub_db.prepare(
          "SELECT * FROM tiktok_automations WHERE video_id = ? AND status = 'active'"
        ).bind(videoId).all();

        for (const auto of (automations.results || [])) {
          // Check keyword match (if keyword set, match; otherwise, reply to all)
          const matchKeyword = !auto.keyword || auto.keyword === "" ||
            text.toLowerCase().includes(auto.keyword.toLowerCase());

          if (!matchKeyword) continue;

          // Generate response
          let responseText = auto.response_template || "Obrigado pelo comentário!";

          if (auto.ai_enabled) {
            try {
              const aiResponse = await generateTikTokReply(text, auto, env);
              if (aiResponse) responseText = aiResponse;
            } catch (e) {
              console.log("[TikTok] AI reply failed, using template:", e.message);
            }
          }

          // Reply to comment via TikTok API
          if (commentId && auto.account_id) {
            const account = await env.criahub_db.prepare(
              "SELECT access_token FROM tiktok_configs WHERE user_id = ? AND status = 'connected'"
            ).bind(auto.user_id).first();

            if (account) {
              await fetch(`${TIKTOK_API_BASE}/comment/reply/`, {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${account.access_token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  comment_id: commentId,
                  text: responseText,
                }),
              });

              // Update DM count
              await env.criahub_db.prepare(
                "UPDATE tiktok_automations SET dm_count = dm_count + 1 WHERE id = ?"
              ).bind(auto.id).run();
            }
          }

          // Log activity
          await env.criahub_db.prepare(
            `INSERT INTO activity_log (ig_account_id, event_type, event_detail, status, created_at) VALUES (?, 'tiktok_comment', ?, 'success', datetime('now'))`
          ).bind(auto.account_id || "tiktok", `TikTok comment on ${videoId}: "${text.substring(0, 100)}" → "${responseText.substring(0, 100)}"`).run();
        }
      }
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("[TikTok Webhook] Erro:", err.message);
    return jsonResponse({ ok: true }); // Always return 200 to webhook
  }
}

async function generateTikTokReply(commentText, automation, env) {
  const groqKey = await getGroqApiKey(env);
  if (!groqKey) return null;

  const systemPrompt = `Responde sempre em português de Portugal (PT-PT). És o assistente de uma empresa chamada CriaHub. Responde de forma breve, simpática e profissional a comentários no TikTok. Máximo 2-3 frases.`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${groqKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Comentário no TikTok: "${commentText}"\n\nContexto da automação: "${automation.name || ''}"` },
      ],
      max_tokens: 150,
      temperature: 0.7,
    }),
  });

  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || null;
}

// ------------------------------------------------------------
// Assinatura e verificação do "state" (protege o fluxo OAuth)
// ------------------------------------------------------------
async function signState(env, payload) {
  const data = { ...payload, ts: Date.now() };
  const json = JSON.stringify(data);
  const encoded = base64UrlEncode(json);
  const signature = await hmacSign(env.OAUTH_STATE_SECRET, encoded);
  return `${encoded}.${signature}`;
}

async function verifyState(env, state) {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;

  const expectedSignature = await hmacSign(env.OAUTH_STATE_SECRET, encoded);
  if (expectedSignature !== signature) return null;

  const json = base64UrlDecode(encoded);
  const data = JSON.parse(json);

  // State expira em 15 minutos
  if (Date.now() - data.ts > 15 * 60 * 1000) return null;

  return data;
}

async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bufferToHex(signatureBuffer);
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");
  return decodeURIComponent(escape(atob(padded)));
}

// ============================================================
// SaaS AUTH — Register / Login / Logout
// ============================================================
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + "_criahub_salt_2026");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function handleRegister(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.email || !body.password || !body.name) {
    return jsonResponse({ error: "email, password and name required" }, 400);
  }
  if (body.password.length < 6) {
    return jsonResponse({ error: "Password must be at least 6 characters" }, 400);
  }

  const existing = await env.criahub_db.prepare("SELECT id FROM saas_users WHERE email = ?").bind(body.email.toLowerCase()).first();
  if (existing) {
    return jsonResponse({ error: "Email already registered" }, 409);
  }

  // Check if approval is required
  let approvalRequired = false;
  try {
    const cfg = await env.criahub_db.prepare("SELECT value FROM system_config WHERE key = 'approval_required'").first();
    approvalRequired = cfg && cfg.value === '1';
  } catch (_) {}

  const userId = "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const passwordHash = await hashPassword(body.password);
  const userStatus = approvalRequired ? 'pending' : 'active';

  await env.criahub_db.prepare(`
    INSERT INTO saas_users (id, email, password_hash, name, status) VALUES (?, ?, ?, ?, ?)
  `).bind(userId, body.email.toLowerCase(), passwordHash, body.name, userStatus).run();

  if (!approvalRequired) {
    // Auto-approve: create 3-day trial
    const subId = "sub_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    await env.criahub_db.prepare(`
      INSERT INTO saas_subscriptions (id, user_id, plan_id, status, started_at, expires_at) VALUES (?, ?, 'plan_business', 'active', datetime('now'), ?)
    `).bind(subId, userId, expiresAt).run();
  }

  if (approvalRequired) {
    // Notify admin of new pending registration
    try {
      await env.criahub_db.prepare(`
        INSERT INTO notifications (title, message, type, icon, active, created_at) VALUES (?, 'Utilizador aguarda aprovacao', 'info', '👤', 1, datetime('now'))
      `).bind(`Novo registo: ${body.name}`).run();
    } catch (_) {}
    return jsonResponse({ ok: true, pending: true, message: "Registo enviado. Aguarda aprovacao do administrador." });
  }

  const sessionToken = crypto.randomUUID().replace(/-/g, "");
  try {
    await env.criahub_db.prepare("INSERT OR REPLACE INTO processed_events (event_id) VALUES (?)").bind("session_" + sessionToken).run();
  } catch (_) {}
  try {
    await env.criahub_db.prepare(`
      INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind("session_user_" + sessionToken, userId).run();
  } catch (_) {}

  return jsonResponse({ ok: true, token: sessionToken, user: { id: userId, email: body.email, name: body.name } });
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.email || !body.password) {
    return jsonResponse({ error: "email and password required" }, 400);
  }

  const user = await env.criahub_db.prepare("SELECT * FROM saas_users WHERE email = ?").bind(body.email.toLowerCase()).first();
  if (!user) {
    return jsonResponse({ error: "Email or password incorrect" }, 401);
  }
  if (user.status === 'pending') {
    return jsonResponse({ error: "Aguarde aprovacao do administrador" }, 403);
  }
  if (user.status === 'banned' || user.status === 'rejected') {
    return jsonResponse({ error: "Conta desativada" }, 403);
  }

  const passwordHash = await hashPassword(body.password);
  if (passwordHash !== user.password_hash) {
    return jsonResponse({ error: "Email or password incorrect" }, 401);
  }

  const sub = await env.criahub_db.prepare(`
    SELECT s.*, p.name as plan_name, p.price_eur_monthly, p.max_accounts, p.max_dms_month, p.max_campaigns
    FROM saas_subscriptions s JOIN saas_plans p ON s.plan_id = p.id
    WHERE s.user_id = ? AND s.status = 'active'
  `).bind(user.id).first();

  const sessionToken = crypto.randomUUID().replace(/-/g, "");
  try {
    await env.criahub_db.prepare("INSERT OR REPLACE INTO processed_events (event_id) VALUES (?)").bind("session_" + sessionToken).run();
  } catch (_) {}

  try {
    await env.criahub_db.prepare(`
      INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind("session_user_" + sessionToken, user.id).run();
  } catch (_) {}

  return jsonResponse({
    ok: true,
    token: sessionToken,
    user: { id: user.id, email: user.email, name: user.name },
    subscription: sub || null
  });
}

async function handleLogout(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace("Bearer ", "");
  if (token) {
    try {
      await env.criahub_db.prepare("DELETE FROM system_config WHERE key = ?").bind("session_user_" + token).run();
    } catch (_) {}
  }
  return jsonResponse({ ok: true });
}

async function handleGetPlans(env) {
  const plans = await env.criahub_db.prepare("SELECT * FROM saas_plans WHERE active = 1 ORDER BY sort_order").all();
  return jsonResponse(plans.results || []);
}

// ============================================================
// SaaS AUTH — helpers
// ============================================================
async function getSaaSUser(env, token) {
  if (!token || token.length < 10) return null;
  const session = await env.criahub_db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").bind("session_" + token).first();
  if (!session) return null;
  const userRow = await env.criahub_db.prepare("SELECT value FROM system_config WHERE key = ?").bind("session_user_" + token).first();
  if (!userRow) return null;
  const user = await env.criahub_db.prepare("SELECT * FROM saas_users WHERE id = ? AND status = 'active'").bind(userRow.value).first();
  return user || null;
}

async function getUserPlan(env, userId) {
  const sub = await env.criahub_db.prepare(`
    SELECT s.*, p.name as plan_name, p.price_eur_monthly, p.max_accounts, p.max_dms_month, p.max_campaigns, p.features
    FROM saas_subscriptions s JOIN saas_plans p ON s.plan_id = p.id
    WHERE s.user_id = ? AND s.status = 'active'
  `).bind(userId).first();
  return sub || null;
}

// ============================================================
// ADMIN FINANCE
// ============================================================
async function handleGetFinance(env) {
  try {
    const totalRevenue = await env.criahub_db.prepare("SELECT COALESCE(SUM(amount_eur), 0) as total FROM saas_payments WHERE status = 'completed'").first();
    const monthRevenue = await env.criahub_db.prepare("SELECT COALESCE(SUM(amount_eur), 0) as total FROM saas_payments WHERE status = 'completed' AND created_at >= date('now', 'start of month')").first();
    const activeSubs = await env.criahub_db.prepare("SELECT COUNT(*) as count FROM saas_subscriptions WHERE status = 'active'").first();
    const totalUsers = await env.criahub_db.prepare("SELECT COUNT(*) as count FROM saas_users WHERE status = 'active'").first();
    let planDist = { results: [] };
    try {
      planDist = await env.criahub_db.prepare(`
        SELECT p.name, p.price_eur_monthly, COUNT(s.id) as subscribers
        FROM saas_plans p LEFT JOIN saas_subscriptions s ON p.id = s.plan_id AND s.status = 'active'
        WHERE p.active = 1 GROUP BY p.id ORDER BY p.sort_order
      `).all();
    } catch (_) {}
    let monthlyRevenue = { results: [] };
    try {
      monthlyRevenue = await env.criahub_db.prepare(`
        SELECT strftime('%Y-%m', created_at) as month, SUM(amount_eur) as revenue, COUNT(*) as payments
        FROM saas_payments WHERE status = 'completed' GROUP BY month ORDER BY month DESC LIMIT 12
      `).all();
    } catch (_) {}
    let recentPayments = { results: [] };
    try {
      recentPayments = await env.criahub_db.prepare(`
        SELECT sp.*, su.email, su.name, sap.name as plan_name
        FROM saas_payments sp LEFT JOIN saas_users su ON sp.user_id = su.id
        LEFT JOIN saas_subscriptions ss ON sp.subscription_id = ss.id
        LEFT JOIN saas_plans sap ON ss.plan_id = sap.id
        ORDER BY sp.created_at DESC LIMIT 20
      `).all();
    } catch (_) {}
    return jsonResponse({
      totalRevenue: totalRevenue?.total || 0,
      monthRevenue: monthRevenue?.total || 0,
      activeSubscribers: activeSubs?.count || 0,
      totalUsers: totalUsers?.count || 0,
      planDistribution: planDist.results || [],
      monthlyRevenue: monthlyRevenue.results || [],
      recentPayments: recentPayments.results || []
    });
  } catch (err) {
    console.error("Finance error:", err);
    return jsonResponse({
      totalRevenue: 0, monthRevenue: 0, activeSubscribers: 0, totalUsers: 0,
      planDistribution: [], monthlyRevenue: [], recentPayments: []
    });
  }
}

async function handleGetSaaSUsers(env) {
  const users = await env.criahub_db.prepare(`
    SELECT su.*, ss.plan_id, sap.name as plan_name, sap.price_eur_monthly,
           ss.status as sub_status, ss.expires_at
    FROM saas_users su
    LEFT JOIN saas_subscriptions ss ON su.id = ss.user_id AND ss.status = 'active'
    LEFT JOIN saas_plans sap ON ss.plan_id = sap.id
    ORDER BY su.created_at DESC
  `).all();
  return jsonResponse(users.results || []);
}

async function handleGetSubscriptions(env) {
  const subs = await env.criahub_db.prepare(`
    SELECT ss.*, su.email, su.name, sap.name as plan_name, sap.price_eur_monthly
    FROM saas_subscriptions ss
    JOIN saas_users su ON ss.user_id = su.id
    JOIN saas_plans sap ON ss.plan_id = sap.id
    ORDER BY ss.created_at DESC
  `).all();
  return jsonResponse(subs.results || []);
}

// ------------------------------------------------------------
// WhatsApp CRM
// ------------------------------------------------------------
async function handleWhatsApp(request, env, path, method) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return jsonResponse({ error: "Unauthorized" }, 401);
  let userId;
  const adminSession = await env.criahub_db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").bind("session_" + token).first();
  if (adminSession) {
    userId = "admin";
  } else {
    const session = await env.criahub_db.prepare("SELECT value FROM system_config WHERE key = ?").bind("session_user_" + token).first();
    if (!session) return jsonResponse({ error: "Invalid session" }, 401);
    userId = session.value;
  }

  if (path === "/api/whatsapp/config" && method === "GET") {
    const config = await env.criahub_db.prepare("SELECT * FROM whatsapp_configs WHERE user_id = ?").bind(userId).first();
    return jsonResponse({ config: config || null });
  }
  if (path === "/api/whatsapp/config" && method === "POST") {
    const body = await request.json();
    const { evo_api_url, evo_api_key, instance_name } = body;
    await env.criahub_db.prepare(`INSERT OR REPLACE INTO whatsapp_configs (user_id, evo_api_url, evo_api_key, instance_name, status, updated_at)
      VALUES (?, ?, ?, ?, 'configured', datetime('now'))`).bind(userId, evo_api_url, evo_api_key, instance_name).run();
    return jsonResponse({ ok: true });
  }
  if (path === "/api/whatsapp/contacts" && method === "GET") {
    const url = new URL(request.url);
    const search = url.searchParams.get("search") || "";
    let q = "SELECT * FROM whatsapp_contacts WHERE user_id = ?";
    const params = [userId];
    if (search) { q += " AND (name LIKE ? OR phone LIKE ?)"; params.push("%" + search + "%", "%" + search + "%"); }
    q += " ORDER BY updated_at DESC LIMIT 100";
    const results = await env.criahub_db.prepare(q).bind(...params).all();
    return jsonResponse({ contacts: results.results || [] });
  }
  if (path === "/api/whatsapp/conversations" && method === "GET") {
    const results = await env.criahub_db.prepare(`SELECT wc.*, wco.name as contact_name FROM whatsapp_conversations wc
      LEFT JOIN whatsapp_contacts wco ON wc.contact_id = wco.id
      WHERE wc.user_id = ? ORDER BY wc.last_message_at DESC LIMIT 50`).bind(userId).all();
    return jsonResponse({ conversations: results.results || [] });
  }
  if (path === "/api/whatsapp/conversations" && method === "POST") {
    const body = await request.json();
    const { contact_id, wa_jid } = body;
    await env.criahub_db.prepare(`INSERT INTO whatsapp_conversations (user_id, contact_id, wa_jid, status)
      VALUES (?, ?, ?, 'open')`).bind(userId, contact_id, wa_jid).run();
    return jsonResponse({ ok: true });
  }
  if (path.startsWith("/api/whatsapp/conversations/") && path.endsWith("/messages") && method === "GET") {
    const convId = path.split("/")[3];
    const results = await env.criahub_db.prepare("SELECT * FROM whatsapp_messages WHERE conversation_id = ? ORDER BY created_at ASC").bind(convId).all();
    return jsonResponse({ messages: results.results || [] });
  }
  if (path.startsWith("/api/whatsapp/conversations/") && path.endsWith("/messages") && method === "POST") {
    const convId = path.split("/")[3];
    const body = await request.json();
    const { content, message_type } = body;
    await env.criahub_db.prepare(`INSERT INTO whatsapp_messages (conversation_id, account_id, from_me, message_type, content)
      VALUES (?, ?, 1, ?, ?)`).bind(convId, userId, message_type || "text", content).run();
    await env.criahub_db.prepare("UPDATE whatsapp_conversations SET last_message = ?, last_message_at = datetime('now') WHERE id = ?").bind(content, convId).run();
    return jsonResponse({ ok: true });
  }
  if (path.startsWith("/api/whatsapp/conversations/") && path.endsWith("/close") && method === "POST") {
    const convId = path.split("/")[3];
    await env.criahub_db.prepare("UPDATE whatsapp_conversations SET status = 'closed' WHERE id = ?").bind(convId).run();
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "Not found" }, 404);
}

// ------------------------------------------------------------
// TikTok API
// ------------------------------------------------------------
async function handleTikTok(request, env, path, method) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return jsonResponse({ error: "Unauthorized" }, 401);
  // Check both admin session and SaaS user session
  let userId;
  const adminSession = await env.criahub_db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").bind("session_" + token).first();
  if (adminSession) {
    userId = "admin";
  } else {
    const session = await env.criahub_db.prepare("SELECT value FROM system_config WHERE key = ?").bind("session_user_" + token).first();
    if (!session) return jsonResponse({ error: "Invalid session" }, 401);
    userId = session.value;
  }

  if (path === "/api/tiktok/config" && method === "GET") {
    const config = await env.criahub_db.prepare("SELECT id, account_id, tiktok_username, tiktok_user_id, status, scopes, created_at FROM tiktok_configs WHERE user_id = ?").bind(userId).first();
    return jsonResponse({ config: config || null });
  }
  if (path === "/api/tiktok/config" && method === "POST") {
    const body = await request.json();
    const { access_token, refresh_token, token_expires_at, tiktok_username, tiktok_user_id } = body;
    await env.criahub_db.prepare(`INSERT OR REPLACE INTO tiktok_configs (user_id, access_token, refresh_token, token_expires_at, tiktok_username, tiktok_user_id, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'connected', datetime('now'))`).bind(userId, access_token, refresh_token, token_expires_at, tiktok_username, tiktok_user_id).run();
    return jsonResponse({ ok: true });
  }
  if (path === "/api/tiktok/config" && method === "DELETE") {
    await env.criahub_db.prepare("DELETE FROM tiktok_configs WHERE user_id = ?").bind(userId).run();
    return jsonResponse({ ok: true });
  }
  if (path === "/api/tiktok/automations" && method === "GET") {
    const results = await env.criahub_db.prepare("SELECT * FROM tiktok_automations WHERE user_id = ? ORDER BY created_at DESC").bind(userId).all();
    return jsonResponse({ automations: results.results || [] });
  }
  if (path === "/api/tiktok/automations" && method === "POST") {
    const body = await request.json();
    const { name, video_id, video_url, keyword, response_template, ai_enabled } = body;
    await env.criahub_db.prepare(`INSERT INTO tiktok_automations (user_id, name, video_id, video_url, keyword, response_template, ai_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(userId, name, video_id, video_url, keyword, response_template, ai_enabled ? 1 : 0).run();
    return jsonResponse({ ok: true });
  }
  if (path.startsWith("/api/tiktok/automations/") && method === "DELETE") {
    const autoId = path.split("/")[3];
    await env.criahub_db.prepare("DELETE FROM tiktok_automations WHERE id = ? AND user_id = ?").bind(autoId, userId).run();
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "Not found" }, 404);
}

// ------------------------------------------------------------
// Meta Ads API
// ------------------------------------------------------------
async function handleMetaAds(request, env, path, method) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return jsonResponse({ error: "Unauthorized" }, 401);
  // Check both admin session and SaaS user session
  let userId;
  const adminSession = await env.criahub_db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").bind("session_" + token).first();
  if (adminSession) {
    userId = "admin";
  } else {
    const session = await env.criahub_db.prepare("SELECT value FROM system_config WHERE key = ?").bind("session_user_" + token).first();
    if (!session) return jsonResponse({ error: "Invalid session" }, 401);
    userId = session.value;
  }

  if (path === "/api/meta-ads/config" && method === "GET") {
    const config = await env.criahub_db.prepare("SELECT id, ad_account_id, business_id, status, last_sync FROM meta_ads_configs WHERE user_id = ?").bind(userId).first();
    return jsonResponse({ config: config || null });
  }
  if (path === "/api/meta-ads/config" && method === "POST") {
    const body = await request.json();
    const { ad_account_id, access_token, business_id, app_id, app_secret, enabled } = body;
    const existing = await env.criahub_db.prepare("SELECT id FROM meta_ads_configs WHERE user_id = ?").bind(userId).first();
    if (existing) {
      await env.criahub_db.prepare(`UPDATE meta_ads_configs SET ad_account_id = ?, access_token = ?, business_id = ?, status = 'connected', updated_at = datetime('now') WHERE user_id = ?`).bind(ad_account_id || null, access_token || null, business_id || null, userId).run();
    } else {
      await env.criahub_db.prepare(`INSERT INTO meta_ads_configs (account_id, user_id, ad_account_id, access_token, business_id, status)
        VALUES (?, ?, ?, ?, ?, 'connected')`).bind("ma_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), userId, ad_account_id || null, access_token || null, business_id || null).run();
    }
    return jsonResponse({ ok: true });
  }
  if (path === "/api/meta-ads/insights" && method === "GET") {
    const url = new URL(request.url);
    const dateFrom = url.searchParams.get("from") || new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
    const dateTo = url.searchParams.get("to") || new Date().toISOString().split("T")[0];
    const results = await env.criahub_db.prepare(`SELECT * FROM campaign_insights
      WHERE user_id = ? AND platform = 'meta' AND date_start >= ? AND date_start <= ?
      ORDER BY date_start DESC LIMIT 200`).bind(userId, dateFrom, dateTo).all();
    const totals = await env.criahub_db.prepare(`SELECT SUM(impressions) as impressions, SUM(clicks) as clicks, SUM(spend) as spend,
      SUM(conversions) as conversions, SUM(leads_count) as leads FROM campaign_insights
      WHERE user_id = ? AND platform = 'meta' AND date_start >= ? AND date_start <= ?`).bind(userId, dateFrom, dateTo).first();
    return jsonResponse({ insights: results.results || [], totals: totals || {} });
  }
  if (path === "/api/meta-ads/lead-forms" && method === "GET") {
    const results = await env.criahub_db.prepare("SELECT * FROM meta_lead_forms WHERE user_id = ? ORDER BY created_at DESC").bind(userId).all();
    return jsonResponse({ forms: results.results || [] });
  }
  if (path === "/api/meta-ads/config" && method === "DELETE") {
    await env.criahub_db.prepare("DELETE FROM meta_ads_configs WHERE user_id = ?").bind(userId).run();
    return jsonResponse({ ok: true });
  }
  // POST /api/meta-ads/sync — fetch insights from Meta Graph API and store
  if (path === "/api/meta-ads/sync" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const dateFrom = body.date_from || new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
    const dateTo = body.date_to || new Date().toISOString().split("T")[0];

    const config = await env.criahub_db.prepare("SELECT ad_account_id, access_token FROM meta_ads_configs WHERE user_id = ? AND status = 'connected'").bind(userId).first();
    if (!config || !config.ad_account_id || !config.access_token) {
      return jsonResponse({ error: "Meta Ads não configurado ou sem credenciais" }, 400);
    }

    try {
      // Fetch insights from Meta Graph API
      const insightsUrl = new URL(`https://graph.facebook.com/v21.0/${config.ad_account_id}/insights`);
      insightsUrl.searchParams.set("access_token", config.access_token);
      insightsUrl.searchParams.set("fields", "campaign_name,campaign_id,impressions,clicks,ctr,spend,actions,reach");
      insightsUrl.searchParams.set("time_range", JSON.stringify({ since: dateFrom, until: dateTo }));
      insightsUrl.searchParams.set("level", "campaign");
      insightsUrl.searchParams.set("limit", "500");

      console.log("[Meta Ads Sync] Fetching:", insightsUrl.toString());
      const res = await fetch(insightsUrl.toString());
      const data = await res.json();
      console.log("[Meta Ads Sync] Response:", JSON.stringify(data).substring(0, 500));

      if (data.error) {
        return jsonResponse({ error: data.error.message || "Erro ao buscar dados do Meta" }, 400);
      }

      const rows = data.data || [];
      let count = 0;

      for (const row of rows) {
        const actions = row.actions || [];
        const leadAction = actions.find(a => a.action_type === "lead" || a.action_type === "offsite_conversion.fb_pixel_lead");
        const leadsCount = leadAction ? parseInt(leadAction.value) : 0;
        const campaignName = row.campaign_name || "Campanha";

        // Delete old data for same campaign + date range, then insert
        await env.criahub_db.prepare(`DELETE FROM campaign_insights WHERE user_id = ? AND platform = 'meta' AND campaign_id = ? AND date_start >= ? AND date_start <= ?`)
          .bind(userId, row.campaign_id || "unknown", dateFrom, dateTo).run();

        await env.criahub_db.prepare(`INSERT INTO campaign_insights (account_id, user_id, platform, campaign_id, campaign_name, date_start, impressions, clicks, ctr, spend, leads_count, reach)
          VALUES (?, ?, 'meta', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            config.ad_account_id || "unknown",
            userId,
            row.campaign_id || "unknown",
            campaignName,
            row.date_start || dateFrom,
            parseInt(row.impressions) || 0,
            parseInt(row.clicks) || 0,
            parseFloat(row.ctr) || 0,
            parseFloat(row.spend) || 0,
            leadsCount,
            parseInt(row.reach) || 0
          ).run();
        count++;
      }

      // Update last_sync
      await env.criahub_db.prepare("UPDATE meta_ads_configs SET last_sync = datetime('now') WHERE user_id = ?").bind(userId).run();

      return jsonResponse({ ok: true, count, period: { from: dateFrom, to: dateTo } });
    } catch (err) {
      console.error("[Meta Ads Sync] Error:", err.message);
      return jsonResponse({ error: "Erro ao sincronizar: " + err.message }, 500);
    }
  }
  return jsonResponse({ error: "Not found" }, 404);
}

// ------------------------------------------------------------
// GA4 API
// ------------------------------------------------------------
async function handleGA4(request, env, path, method) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return jsonResponse({ error: "Unauthorized" }, 401);
  // Check both admin session and SaaS user session
  let userId;
  const adminSession = await env.criahub_db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").bind("session_" + token).first();
  if (adminSession) {
    userId = "admin";
  } else {
    const session = await env.criahub_db.prepare("SELECT value FROM system_config WHERE key = ?").bind("session_user_" + token).first();
    if (!session) return jsonResponse({ error: "Invalid session" }, 401);
    userId = session.value;
  }

  if (path === "/api/ga4/config" && method === "GET") {
    const config = await env.criahub_db.prepare("SELECT id, property_id, property_name, service_account_email, status, last_sync FROM ga4_configs WHERE user_id = ?").bind(userId).first();
    return jsonResponse({ config: config || null });
  }
  if (path === "/api/ga4/config" && method === "POST") {
    const body = await request.json();
    const { property_id, property_name, service_account_email, private_key, service_account_json, period, enabled } = body;
    let parsedEmail = service_account_email || null;
    let parsedKey = private_key || null;
    if (service_account_json && !parsedEmail) {
      try {
        const sa = JSON.parse(service_account_json);
        parsedEmail = sa.client_email || null;
        parsedKey = sa.private_key || null;
      } catch (e) {}
    }
    const existing = await env.criahub_db.prepare("SELECT id FROM ga4_configs WHERE user_id = ?").bind(userId).first();
    if (existing) {
      await env.criahub_db.prepare(`UPDATE ga4_configs SET property_id = ?, property_name = ?, service_account_email = ?, private_key = ?, status = 'connected', updated_at = datetime('now') WHERE user_id = ?`).bind(property_id || null, property_name || null, parsedEmail, parsedKey, userId).run();
    } else {
      await env.criahub_db.prepare(`INSERT INTO ga4_configs (account_id, user_id, property_id, property_name, service_account_email, private_key, status)
        VALUES (?, ?, ?, ?, ?, ?, 'connected')`).bind("ga4_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), userId, property_id || null, property_name || null, parsedEmail, parsedKey).run();
    }
    return jsonResponse({ ok: true });
  }
  if (path === "/api/ga4/data" && method === "GET") {
    const url = new URL(request.url);
    const dateFrom = url.searchParams.get("from") || new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
    const dateTo = url.searchParams.get("to") || new Date().toISOString().split("T")[0];
    const config = await env.criahub_db.prepare("SELECT account_id, property_id FROM ga4_configs WHERE user_id = ?").bind(userId).first();
    const accountId = config?.account_id || "ga4";
    const results = await env.criahub_db.prepare(`SELECT * FROM ga4_data
      WHERE account_id = ? AND date >= ? AND date <= ?
      ORDER BY date DESC LIMIT 500`).bind(accountId, dateFrom, dateTo).all();

    // Aggregate into totals
    const totals = {};
    for (const row of (results.results || [])) {
      const name = row.metric_name;
      totals[name] = (totals[name] || 0) + (row.metric_value || 0);
    }
    return jsonResponse({ data: totals, rows: results.results || [] });
  }
  if (path === "/api/ga4/config" && method === "DELETE") {
    await env.criahub_db.prepare("DELETE FROM ga4_configs WHERE user_id = ?").bind(userId).run();
    return jsonResponse({ ok: true });
  }
  // POST /api/ga4/sync — fetch data from Google Analytics Data API
  if (path === "/api/ga4/sync" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const dateFrom = body.date_from || new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
    const dateTo = body.date_to || new Date().toISOString().split("T")[0];

    const config = await env.criahub_db.prepare("SELECT * FROM ga4_configs WHERE user_id = ? AND status = 'connected'").bind(userId).first();
    if (!config || !config.service_account_email || !config.private_key || !config.property_id) {
      return jsonResponse({ error: "GA4 não configurado ou sem credenciais completas (precisa de Property ID, Service Account Email e Private Key)" }, 400);
    }

    try {
      // Step 1: Create JWT and get access token from Google
      const now = Math.floor(Date.now() / 1000);
      const header = { alg: "RS256", typ: "JWT" };
      const payload = {
        iss: config.service_account_email,
        scope: "https://www.googleapis.com/auth/analytics.readonly",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      };

      const encodedHeader = btoa(JSON.stringify(header)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const encodedPayload = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const signingInput = `${encodedHeader}.${encodedPayload}`;

      // Import private key for signing
      const pemKey = config.private_key;
      const pemBody = pemKey.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s/g, "");
      const binaryKey = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

      const cryptoKey = await crypto.subtle.importKey(
        "pkcs8", binaryKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
      );

      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
      const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const jwt = `${signingInput}.${encodedSignature}`;

      // Step 2: Exchange JWT for access token
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
      });
      const tokenData = await tokenRes.json();

      if (!tokenData.access_token) {
        console.error("[GA4 Sync] Token error:", JSON.stringify(tokenData));
        return jsonResponse({ error: "Erro ao obter token GA4: " + (tokenData.error_description || tokenData.error || "Credenciais inválidas") }, 400);
      }

      // Step 3: Call GA4 Data API
      const propertyId = config.property_id;
      const reportUrl = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;

      const reportBody = {
        dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
        metrics: [
          { name: "activeUsers" },
          { name: "sessions" },
          { name: "screenPageViews" },
          { name: "bounceRate" },
          { name: "averageSessionDuration" },
          { name: "conversions" },
        ],
        dimensions: [
          { name: "date" },
        ],
      };

      const reportRes = await fetch(reportUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${tokenData.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(reportBody),
      });
      const reportData = await reportRes.json();
      console.log("[GA4 Sync] Report:", JSON.stringify(reportData).substring(0, 500));

      if (reportData.error) {
        return jsonResponse({ error: "Erro GA4 API: " + (reportData.error.message || JSON.stringify(reportData.error)) }, 400);
      }

      // Step 4: Store results
      const rows = reportData.rows || [];
      let count = 0;

      // Clear old data for this user + period
      await env.criahub_db.prepare("DELETE FROM ga4_data WHERE account_id = ? AND date >= ? AND date <= ?")
        .bind(config.account_id || "ga4", dateFrom, dateTo).run();

      for (const row of rows) {
        const rawDate = row.dimensionValues?.[0]?.value || dateFrom;
        // GA4 API returns YYYYMMDD — convert to YYYY-MM-DD for SQL comparison
        const date = rawDate.length === 8 && !rawDate.includes('-')
          ? `${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}`
          : rawDate;
        const metrics = row.metricValues || [];
        const metricNames = ["activeUsers", "sessions", "pageViews", "bounceRate", "avgSessionDuration", "conversions"];

        for (let i = 0; i < metricNames.length; i++) {
          const val = parseFloat(metrics[i]?.value) || 0;
          if (val > 0 || i < 3) { // store always: activeUsers, sessions, pageViews
            await env.criahub_db.prepare(`INSERT INTO ga4_data (account_id, property_id, metric_name, metric_value, dimension, dimension_value, date)
              VALUES (?, ?, ?, ?, 'date', ?, ?)`)
              .bind(config.account_id || "ga4", config.property_id, metricNames[i], val, date, date).run();
            count++;
          }
        }
      }

      // Also fetch totals (without date dimension)
      const totalsBody = {
        dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
        metrics: [
          { name: "activeUsers" },
          { name: "sessions" },
          { name: "screenPageViews" },
          { name: "bounceRate" },
          { name: "averageSessionDuration" },
          { name: "conversions" },
        ],
      };

      const totalsRes = await fetch(reportUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${tokenData.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(totalsBody),
      });
      const totalsData = await totalsRes.json();
      const totalsRow = totalsData.rows?.[0]?.metricValues || [];

      await env.criahub_db.prepare("UPDATE ga4_configs SET last_sync = datetime('now') WHERE user_id = ?").bind(userId).run();

      return jsonResponse({
        ok: true, count,
        totals: {
          activeUsers: parseInt(totalsRow[0]?.value) || 0,
          sessions: parseInt(totalsRow[1]?.value) || 0,
          pageViews: parseInt(totalsRow[2]?.value) || 0,
          bounceRate: parseFloat(totalsRow[3]?.value) || 0,
          avgSessionDuration: parseFloat(totalsRow[4]?.value) || 0,
          conversions: parseInt(totalsRow[5]?.value) || 0,
        },
        period: { from: dateFrom, to: dateTo },
      });
    } catch (err) {
      console.error("[GA4 Sync] Error:", err.message);
      return jsonResponse({ error: "Erro ao sincronizar GA4: " + err.message }, 500);
    }
  }
  return jsonResponse({ error: "Not found" }, 404);
}

// ------------------------------------------------------------
// Leads API
// ------------------------------------------------------------
async function handleLeads(request, env, path, method) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return jsonResponse({ error: "Unauthorized" }, 401);
  let userId;
  const adminSession = await env.criahub_db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").bind("session_" + token).first();
  if (adminSession) {
    userId = "admin";
  } else {
    const session = await env.criahub_db.prepare("SELECT value FROM system_config WHERE key = ?").bind("session_user_" + token).first();
    if (!session) return jsonResponse({ error: "Invalid session" }, 401);
    userId = session.value;
  }

  if (path === "/api/leads" && method === "GET") {
    const url = new URL(request.url);
    const source = url.searchParams.get("source") || "";
    const status = url.searchParams.get("status") || "";
    const search = url.searchParams.get("search") || "";
    let q = "SELECT * FROM leads WHERE user_id = ?";
    const params = [userId];
    if (source) { q += " AND source = ?"; params.push(source); }
    if (status) { q += " AND status = ?"; params.push(status); }
    if (search) { q += " AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)"; params.push("%" + search + "%", "%" + search + "%", "%" + search + "%"); }
    q += " ORDER BY created_at DESC LIMIT 200";
    const results = await env.criahub_db.prepare(q).bind(...params).all();
    const stats = await env.criahub_db.prepare(`SELECT source, status, COUNT(*) as count FROM leads WHERE user_id = ? GROUP BY source, status`).bind(userId).all();
    return jsonResponse({ leads: results.results || [], stats: stats.results || [] });
  }
  if (path === "/api/leads" && method === "POST") {
    const body = await request.json();
    const { source, source_id, name, email, phone, platform, campaign_id, campaign_name, form_name, tags, custom_fields } = body;

    // Enforce plan limits on contacts
    const limitCheck = await checkPlanLimit(env.criahub_db || env.criahub_db, userId, 'contacts');
    if (!limitCheck.ok) return jsonResponse({ error: `Limite de contactos atingido: ${limitCheck.usage}/${limitCheck.limit}. Faça upgrade.`, upgrade_required: true }, 403);

    await env.criahub_db.prepare(`INSERT INTO leads (user_id, source, source_id, name, email, phone, platform, campaign_id, campaign_name, form_name, tags, custom_fields)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(userId, source, source_id, name, email, phone, platform, campaign_id, campaign_name, form_name, JSON.stringify(tags || []), JSON.stringify(custom_fields || {})).run();
    return jsonResponse({ ok: true });
  }
  if (path.startsWith("/api/leads/") && path.endsWith("/status") && method === "POST") {
    const leadId = path.split("/")[3];
    const body = await request.json();
    await env.criahub_db.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(body.status, leadId, userId).run();
    return jsonResponse({ ok: true });
  }
  if (path.startsWith("/api/leads/") && path.endsWith("/activities") && method === "GET") {
    const leadId = path.split("/")[3];
    const results = await env.criahub_db.prepare("SELECT * FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC").bind(leadId).all();
    return jsonResponse({ activities: results.results || [] });
  }
  if (path.startsWith("/api/leads/") && path.endsWith("/activities") && method === "POST") {
    const leadId = path.split("/")[3];
    const body = await request.json();
    await env.criahub_db.prepare("INSERT INTO lead_activities (lead_id, account_id, type, description, performed_by) VALUES (?, ?, ?, ?, ?)").bind(leadId, userId, body.type, body.description, body.performed_by || "user").run();
    return jsonResponse({ ok: true });
  }
  if (path === "/api/leads/stats" && method === "GET") {
    const total = await env.criahub_db.prepare("SELECT COUNT(*) as total FROM leads WHERE user_id = ?").bind(userId).first();
    const bySource = await env.criahub_db.prepare("SELECT source, COUNT(*) as count FROM leads WHERE user_id = ? GROUP BY source").bind(userId).all();
    const byStatus = await env.criahub_db.prepare("SELECT status, COUNT(*) as count FROM leads WHERE user_id = ? GROUP BY status").bind(userId).all();
    return jsonResponse({ total: total?.total || 0, bySource: bySource.results || [], byStatus: byStatus.results || [] });
  }
  return jsonResponse({ error: "Not found" }, 404);
}

// ------------------------------------------------------------
// Helpers de resposta
// ------------------------------------------------------------
function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(`<html><body style="font-family: sans-serif; padding: 40px;">${html}</body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}