/**
 * Sister-portal hook for seminar, autism and fellowship.
 * Exposes a VGMF-shaped schedule feed (Express apps) and pushes new
 * accounts, events, notices, tickets/applications and payments
 * (never QR codes or passwords) to the Foundation ingest API.
 */
const https = require("https");
const http = require("http");
const { spawn } = require("child_process");
const { URL } = require("url");

const DEFAULT_URLS = [
  "https://staging.vaidyagogate.org/api/partners/ingest",
  "https://demo.vaidyagogate.org/api/partners/ingest",
];

function ingestUrls() {
  const raw = (process.env.VGMF_INGEST_URLS || "").trim();
  return (raw ? raw.split(",") : DEFAULT_URLS).map((item) => item.trim()).filter(Boolean);
}

function ingestKey(portal) {
  if (process.env.VGMF_INGEST_KEY) return process.env.VGMF_INGEST_KEY;
  if (portal === "autism") return process.env.AUTISM_CERT_API_KEY || "vgmf_live_autism_4b8d1e6a";
  if (portal === "fellowship") return process.env.FELLOWSHIP_CERT_API_KEY || "vgmf_live_fellowship_9c2e4a1b";
  return process.env.SEMINAR_CERT_API_KEY || "vgmf_live_seminar_7f3a9c2e";
}

function postJson(url, headers, body) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false });
      return;
    }
    const payload = Buffer.from(JSON.stringify(body));
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
          accept: "application/json",
          ...headers,
        },
        timeout: 8000,
      },
      (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 });
      }
    );
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.end(payload);
  });
}

function dbAll(db, sql, params) {
  if (db && typeof db.all === "function") {
    return new Promise((resolve) => {
      db.all(sql, params || [], (err, rows) => resolve(err ? [] : rows || []));
    });
  }
  return psqlAll(sql);
}

function psqlAll(sql) {
  const url = process.env.DATABASE_URL || "";
  if (!url) return Promise.resolve([]);
  const wrapped = `SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (${sql.replace(/;+\s*$/, "")}) t`;
  return new Promise((resolve) => {
    const child = spawn("psql", [url, "-Atc", wrapped], { env: process.env });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => resolve([]));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out.trim() || "[]");
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
  });
}

function originFor(portal) {
  if (portal === "autism") return "https://autism.vaidyagogate.org";
  if (portal === "fellowship") return "https://fellowship.vaidyagogate.org";
  return "https://seminar.vaidyagogate.org";
}

function sanitizeAccount(row) {
  const full = String(row.first_name || row.name || "").trim();
  const parts = full.split(/\s+/).filter(Boolean);
  return {
    id: row.id,
    accountId: row.user_id_string || row.user_id,
    firstName: row.first_name || parts[0] || "Member",
    lastName: row.last_name || parts.slice(1).join(" "),
    email: row.email,
    phone: row.phone || row.mobile,
    whatsapp: row.whatsapp || row.phone || row.mobile,
    role: row.role,
    user_role: row.user_role,
    createdAt: row.created_at,
  };
}

async function pushAll(portal, body) {
  const urls = ingestUrls();
  const key = ingestKey(portal);
  if (!urls.length || !key) return;
  for (const url of urls) {
    await postJson(url, { "x-api-key": key }, { portal, ...body });
  }
}

async function pushSeminarLike({ db, portal, origin }) {
  const users = await dbAll(
    db,
    `SELECT id, user_id_string, first_name, last_name, email, phone, whatsapp, role, user_role, created_at
       FROM users
      WHERE created_at >= NOW() - INTERVAL '30 minutes'
        AND COALESCE(role, '') NOT IN ('admin')
        AND COALESCE(user_role, '') NOT IN ('admin', 'co_admin')
      ORDER BY created_at DESC
      LIMIT 50`
  );
  const tickets = await dbAll(
    db,
    `SELECT t.id, t.user_id, t.ticket_id_string, t.is_valid, t.event_id, u.email AS user_email
       FROM tickets t
       LEFT JOIN users u ON u.id = t.user_id
      WHERE t.id IN (SELECT id FROM tickets ORDER BY id DESC LIMIT 40)`
  );
  const seminars = await dbAll(db, `SELECT * FROM seminars ORDER BY event_date DESC NULLS LAST, id DESC LIMIT 12`);
  const noticeSql =
    portal === "autism"
      ? `SELECT id, message AS title, message AS description, pdf_path, created_at FROM notices ORDER BY created_at DESC LIMIT 20`
      : `SELECT id, title, content AS description, pdf_path, created_at FROM notices ORDER BY created_at DESC LIMIT 20`;
  const notices = await dbAll(db, noticeSql);
  const payments = await dbAll(
    db,
    `SELECT id, user_id, user_email, amount, status, created_at, application_no
       FROM payment_attempts
      ORDER BY id DESC
      LIMIT 30`
  ).catch(() => []);

  for (const seminar of seminars) {
    await pushAll(portal, { event: seminar });
  }
  for (const notice of notices) {
    await pushAll(portal, {
      notice: {
        id: `${portal}-notice-${notice.id}`,
        title: notice.title || "Notice",
        description: notice.description || notice.title || "",
        date: notice.created_at,
        href: notice.pdf_path ? `${origin}${String(notice.pdf_path).startsWith("/") ? "" : "/"}${notice.pdf_path}` : origin,
      },
    });
  }
  for (const user of users) {
    const email = String(user.email || "").toLowerCase();
    const userTickets = tickets.filter((item) => String(item.user_id) === String(user.id) || String(item.user_email || "").toLowerCase() === email);
    const userPayments = (payments || []).filter((item) => String(item.user_id) === String(user.id) || String(item.user_email || "").toLowerCase() === email);
    await pushAll(portal, {
      account: sanitizeAccount(user),
      hasTicket: userTickets.length > 0,
      ticket: userTickets[0]
        ? {
            id: `${portal}-tkt-${userTickets[0].id}`,
            eventName: portal === "seminar" ? "Seminar" : "Autism programme",
            status: Number(userTickets[0].is_valid) === 0 ? "Invalid" : "Issued",
          }
        : undefined,
      payment: userPayments[0]
        ? {
            id: `${portal}-pay-${userPayments[0].id}`,
            amount: userPayments[0].amount,
            status: userPayments[0].status || "Recorded",
            eventName: userPayments[0].application_no,
          }
        : undefined,
    });
  }
  for (const ticket of tickets) {
    const email = String(ticket.user_email || "").toLowerCase();
    if (!email) continue;
    await pushAll(portal, {
      email,
      ticket: {
        id: `${portal}-tkt-${ticket.id}`,
        eventName: portal === "seminar" ? "Seminar" : "Autism programme",
        status: Number(ticket.is_valid) === 0 ? "Invalid" : "Issued",
      },
    });
  }
}

async function pushFellowship({ db, portal, origin }) {
  const settings = (await dbAll(db, `SELECT site_name, hero_title, site_tagline, signup_enabled, ticker_text, ticker_enabled FROM site_settings LIMIT 1`))[0];
  if (settings) {
    await pushAll(portal, {
      event: {
        id: "programme",
        title: settings.hero_title || settings.site_name || "Research Fellowship 2026",
        description: settings.site_tagline,
        registration_enabled: settings.signup_enabled,
      },
    });
  }
  const notices = await dbAll(
    db,
    `SELECT id, title, content, category::text AS category, published_at, created_at
       FROM notices
      WHERE coalesce(is_active, true) = true
      ORDER BY published_at DESC NULLS LAST
      LIMIT 20`
  );
  for (const notice of notices) {
    await pushAll(portal, {
      notice: {
        id: `fellowship-notice-${notice.id}`,
        title: notice.title || "Notice",
        description: notice.content || notice.title,
        date: notice.published_at || notice.created_at,
        href: origin,
      },
    });
  }
  const users = await dbAll(
    db,
    `SELECT id, user_id, email, phone, role::text AS role, created_at
       FROM users
      WHERE created_at >= NOW() - INTERVAL '30 minutes'
        AND role::text NOT IN ('ADMIN', 'COADMIN', 'COMMITTEE')
      ORDER BY created_at DESC
      LIMIT 50`
  );
  const applications = await dbAll(
    db,
    `SELECT id, application_number, user_id, name, email, mobile, status::text AS status, submitted_at
       FROM applications
      ORDER BY created_at DESC
      LIMIT 40`
  );
  for (const user of users) {
    const email = String(user.email || "").toLowerCase();
    const app = applications.find((item) => String(item.user_id) === String(user.id) || String(item.email || "").toLowerCase() === email);
    await pushAll(portal, {
      account: sanitizeAccount({ ...user, name: app?.name, mobile: app?.mobile || user.phone }),
      hasTicket: Boolean(app),
      application: app
        ? {
            id: `fellowship-app-${app.id}`,
            eventName: app.application_number ? `Fellowship ${app.application_number}` : "Research Fellowship 2026",
            status: String(app.status || "Submitted").replace(/_/g, " "),
            issuedAt: app.submitted_at,
          }
        : undefined,
    });
  }
  for (const app of applications) {
    const email = String(app.email || "").toLowerCase();
    if (!email) continue;
    await pushAll(portal, {
      email,
      account: sanitizeAccount({ id: app.user_id, email: app.email, name: app.name, mobile: app.mobile, role: "APPLICANT" }),
      application: {
        id: `fellowship-app-${app.id}`,
        eventName: app.application_number ? `Fellowship ${app.application_number}` : "Research Fellowship 2026",
        status: String(app.status || "Submitted").replace(/_/g, " "),
        issuedAt: app.submitted_at,
      },
    });
  }
}

async function pushRecent({ db, portal, origin }) {
  const urls = ingestUrls();
  const key = ingestKey(portal);
  if (!urls.length || !key) return;
  if (portal === "fellowship") return pushFellowship({ db, portal, origin });
  return pushSeminarLike({ db, portal, origin });
}

function install({ app, db, portal }) {
  const origin = originFor(portal);

  if (app && typeof app.get === "function") {
    app.get("/api/public/vgmf-feed", (req, res) => {
      db.all(
        `SELECT * FROM seminars ORDER BY event_date DESC NULLS LAST, id DESC`,
        [],
        (seminarErr, seminars) => {
          db.all(
            `SELECT es.id, es.title, es.description, es.seminar_id, es.start_time, es.end_time,
                    es.location, es.speaker_name, es.speaker_bio, s.title AS seminar_title
               FROM event_schedules es
               LEFT JOIN seminars s ON es.seminar_id = s.id
              ORDER BY es.start_time ASC`,
            [],
            (scheduleErr, schedules) => {
              if (seminarErr && scheduleErr) return res.status(500).json({ error: "Could not load schedule." });
              res.json({
                portal,
                origin,
                seminars: seminars || [],
                schedules: schedules || [],
              });
            }
          );
        }
      );
    });
  }

  const tick = () => {
    pushRecent({ db, portal, origin }).catch(() => undefined);
  };
  setTimeout(tick, 20_000);
  setInterval(tick, 120_000);
}

if (require.main === module) {
  const portal = process.env.VGMF_INGEST_PORTAL || process.argv[2] || "fellowship";
  install({ app: null, db: null, portal });
  console.log("[vgmf-ingest] standalone", portal);
}

module.exports = { install };
