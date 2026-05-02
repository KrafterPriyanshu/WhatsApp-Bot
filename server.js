require("dotenv").config();
const fs = require("fs");
const path = require("path");

// Puppeteer (whatsapp-web.js): use project-local Chrome from postinstall (required on Render).
if (!process.env.PUPPETEER_CACHE_DIR) {
  process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, ".cache", "puppeteer");
}
const http = require("http");
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const db = require("./db");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 3000;
const TEMPLATE_IMAGE_DIR = path.join(__dirname, "uploads", "template-images");
const ALLOWED_TEMPLATE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

fs.mkdirSync(TEMPLATE_IMAGE_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const templateImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, TEMPLATE_IMAGE_DIR),
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const safe =
        ext === ".jpeg" ? ".jpg" : [".jpg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 12)}${safe}`);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (ALLOWED_TEMPLATE_IMAGE_TYPES.has(file.mimetype)) return cb(null, true);
    cb(new Error("Only JPEG, PNG, WebP, or GIF images are allowed."));
  },
});
const DEFAULT_SUPPORT_REPLY =
  process.env.SUPPORT_AUTO_REPLY ||
  "Thanks for contacting support. Our team will get back to you soon.";

app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-me-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

const waState = {
  isReady: false,
  lastQrAt: null,
  lastError: null,
  qrDataUrl: null,
};

const waClient = new Client({
  authStrategy: new LocalAuth({ clientId: "marketing-bot" }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  },
});

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function storedRelPathFromTemplateFilename(filename) {
  if (!filename) return "";
  return path.join("uploads", "template-images", filename).split(path.sep).join("/");
}

function fullPathForStoredTemplateImage(rel) {
  if (!rel || typeof rel !== "string" || rel.includes("..")) return null;
  const normalizedRel = String(rel).replace(/\\/g, path.sep).trim();
  const full = path.resolve(__dirname, normalizedRel);
  const allowedRoot = path.resolve(TEMPLATE_IMAGE_DIR);
  if (!full.startsWith(path.join(allowedRoot, path.sep)) && full !== allowedRoot) {
    return null;
  }
  return full;
}

function unlinkTemplateImageByRelative(rel) {
  const abs = fullPathForStoredTemplateImage(rel);
  if (abs && fs.existsSync(abs)) {
    try {
      fs.unlinkSync(abs);
    } catch (_) {
      /* ignore */
    }
  }
}

async function resolveWhatsAppChatId(to, preferredChatId = "") {
  const raw = String(to || "").trim();
  const preferred = String(preferredChatId || "").trim();
  let chatId = preferred || raw;

  if (!chatId.includes("@")) {
    try {
      const numberId = await waClient.getNumberId(raw.replace(/\D/g, ""));
      if (numberId?._serialized) {
        chatId = numberId._serialized;
      } else {
        chatId = `${raw.replace(/\D/g, "")}@c.us`;
      }
    } catch (_) {
      chatId = `${raw.replace(/\D/g, "")}@c.us`;
    }
  }
  return chatId;
}

async function sendWhatsAppText(to, bodyText, preferredChatId = "") {
  if (!waState.isReady) {
    throw new Error("WhatsApp Web is not ready. Scan QR first.");
  }
  const chatId = await resolveWhatsAppChatId(to, preferredChatId);
  const sentMessage = await waClient.sendMessage(chatId, bodyText);
  return { id: sentMessage.id?._serialized || null };
}

async function sendWhatsAppCampaignMessage(customer, bodyText, template) {
  if (!waState.isReady) {
    throw new Error("WhatsApp Web is not ready. Scan QR first.");
  }
  const chatId = await resolveWhatsAppChatId(customer.phone, customer.wa_chat_id);
  const rel = template?.image_path ? String(template.image_path).trim() : "";
  const abs = rel ? fullPathForStoredTemplateImage(rel) : null;

  if (abs && fs.existsSync(abs)) {
    const media = MessageMedia.fromFilePath(abs);
    const sent = await waClient.sendMessage(chatId, media, { caption: bodyText });
    return { id: sent.id?._serialized || null };
  }

  const sentMessage = await waClient.sendMessage(chatId, bodyText);
  return { id: sentMessage.id?._serialized || null };
}

function renderTemplate(content, customer) {
  return content
    .replaceAll("{{name}}", customer.name || "")
    .replaceAll("{{phone}}", customer.phone || "");
}

async function getSupportBotConfig() {
  const config = await getQuery("SELECT * FROM support_bot_config WHERE id = 1");
  if (config) return config;

  await runQuery("INSERT INTO support_bot_config (id, enabled, fallback_reply) VALUES (1, 1, ?)", [
    DEFAULT_SUPPORT_REPLY,
  ]);
  return { id: 1, enabled: 1, fallback_reply: DEFAULT_SUPPORT_REPLY };
}

function getSmartSupportReply(messageText, customerName, fallbackReply) {
  const text = String(messageText || "").toLowerCase();
  const name = customerName || "there";

  const rules = [
    {
      keywords: ["hi", "hello", "hey"],
      reply: `Hi ${name}! Welcome to support. How can we help you today?`,
    },
    {
      keywords: ["price", "pricing", "cost", "plan"],
      reply:
        "Our pricing depends on your requirements. Please share what service you need, and our team will send details shortly.",
    },
    {
      keywords: ["order", "status", "track", "tracking"],
      reply:
        "Please share your order ID. We will check the latest status and get back to you quickly.",
    },
    {
      keywords: ["human", "agent", "support", "call"],
      reply:
        "Sure, we are assigning this to a human support agent now. You will receive a response soon.",
    },
    {
      keywords: ["thanks", "thank you", "thx"],
      reply: `You're welcome, ${name}. If you need anything else, just message us.`,
    },
  ];

  const matchedRule = rules.find((rule) => rule.keywords.some((keyword) => text.includes(keyword)));
  return matchedRule?.reply || `Hi ${name}, ${fallbackReply}`;
}

function getFaqReply(messageText, faqRules = []) {
  const text = String(messageText || "").toLowerCase();
  if (!text.trim()) return null;

  for (const rule of faqRules) {
    const keywords = String(rule.question_keywords || "")
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (keywords.some((keyword) => text.includes(keyword))) {
      return rule.answer;
    }
  }
  return null;
}

function redirectBack(req, res, fallback = "/dashboard") {
  const referer = req.get("referer");
  return res.redirect(referer || fallback);
}

function escapeSqliteLike(pattern) {
  return String(pattern).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function emitRealtime(event, payload = {}) {
  io.emit("app:update", {
    event,
    at: new Date().toISOString(),
    ...payload,
  });
}

function getCsvValue(row, keys = []) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return String(row[key]).trim();
  }
  return "";
}

function parseCsvCustomers(csvBuffer) {
  const csvText = String(csvBuffer || "");
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: true,
  });

  const prepared = [];
  const rowErrors = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const rawPhone = getCsvValue(row, ["phone", "Phone", "PHONE", "mobile", "Mobile", "MOBILE"]);
    const phone = rawPhone.replace(/\D/g, "");
    if (!phone) {
      rowErrors.push(`Row ${rowNumber}: missing phone`);
      return;
    }
    const name =
      getCsvValue(row, ["name", "Name", "NAME", "full_name", "fullName"]) || "New Customer";
    const tags = getCsvValue(row, ["tags", "Tags", "TAGS"]);
    prepared.push({ name, phone, tags });
  });

  return { prepared, rowErrors };
}

function notifyAndRedirect(req, res, event = "data:changed") {
  emitRealtime(event);
  return redirectBack(req, res);
}

app.use((req, res, next) => {
  res.locals.currentUser = req.session?.user || null;
  next();
});

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect("/login");
}

app.use((req, res, next) => {
  const originalRedirect = res.redirect.bind(res);
  res.redirect = (...args) => {
    if (req.method === "POST") {
      emitRealtime("data:changed", { path: req.path });
    }
    return originalRedirect(...args);
  };
  next();
});

app.get("/login", (req, res) => {
  if (req.session?.user) return res.redirect("/dashboard");
  return res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!username || !password) return res.render("login", { error: "Enter username and password." });

  const admin = await getQuery("SELECT * FROM admins WHERE username = ?", [username]);
  if (!admin) return res.render("login", { error: "Invalid credentials." });

  const passwordOk = bcrypt.compareSync(password, admin.password_hash);
  if (!passwordOk) return res.render("login", { error: "Invalid credentials." });

  req.session.user = { id: admin.id, username: admin.username, role: admin.role };
  return res.redirect("/dashboard");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.use((req, res, next) => {
  const publicPaths = new Set(["/login", "/health"]);
  if (publicPaths.has(req.path)) return next();
  return requireAuth(req, res, next);
});

app.use("/upload-template-images", express.static(TEMPLATE_IMAGE_DIR));

async function getCounts() {
  const [customerCount, templateCount, campaignCount, messageCount, optedOutCount] = await Promise.all([
    getQuery("SELECT COUNT(*) AS count FROM customers"),
    getQuery("SELECT COUNT(*) AS count FROM templates"),
    getQuery("SELECT COUNT(*) AS count FROM campaigns"),
    getQuery("SELECT COUNT(*) AS count FROM messages"),
    getQuery("SELECT COUNT(*) AS count FROM customers WHERE is_opted_out = 1"),
  ]);

  return {
    customers: customerCount?.count || 0,
    templates: templateCount?.count || 0,
    campaigns: campaignCount?.count || 0,
    messages: messageCount?.count || 0,
    optedOut: optedOutCount?.count || 0,
  };
}

async function processCampaign(campaignId) {
  const campaign = await getQuery("SELECT * FROM campaigns WHERE id = ?", [campaignId]);
  if (!campaign) return;

  const template = await getQuery("SELECT * FROM templates WHERE id = ?", [campaign.template_id]);
  if (!template) {
    await runQuery("UPDATE campaigns SET status = ? WHERE id = ?", ["failed: missing template", campaignId]);
    return;
  }

  await runQuery("UPDATE campaigns SET status = ? WHERE id = ?", ["processing", campaignId]);

  let customers = [];
  if (campaign.tag_filter && campaign.tag_filter.trim()) {
    customers = await allQuery(
      "SELECT * FROM customers WHERE tags LIKE ? AND is_opted_out = 0",
      [`%${campaign.tag_filter.trim()}%`]
    );
  } else {
    customers = await allQuery("SELECT * FROM customers WHERE is_opted_out = 0");
  }

  await runQuery("UPDATE campaigns SET customer_count = ? WHERE id = ?", [customers.length, campaignId]);

  for (const customer of customers) {
    const text = renderTemplate(template.content, customer);
    try {
      const waData = await sendWhatsAppCampaignMessage(customer, text, template);
      const waMessageId = waData?.id || null;
      await runQuery(
        "INSERT INTO messages (customer_id, direction, body, wa_message_id, status) VALUES (?, ?, ?, ?, ?)",
        [customer.id, "outbound", text, waMessageId, "sent"]
      );
    } catch (error) {
      await runQuery(
        "INSERT INTO messages (customer_id, direction, body, status) VALUES (?, ?, ?, ?)",
        [customer.id, "outbound", text, `failed: ${error.message}`]
      );
    }
  }

  await runQuery("UPDATE campaigns SET status = ? WHERE id = ?", ["done", campaignId]);
  emitRealtime("campaign:processed", { campaignId });
}

async function processDueCampaigns() {
  const dueCampaigns = await allQuery(
    "SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= datetime('now')"
  );
  for (const campaign of dueCampaigns) {
    await processCampaign(campaign.id);
  }
}

app.get("/", (req, res) => res.redirect("/dashboard"));

app.get("/dashboard", async (req, res) => {
  const [counts, campaigns, messages] = await Promise.all([
    getCounts(),
    allQuery(`
      SELECT campaigns.*, templates.name AS template_name
      FROM campaigns
      JOIN templates ON campaigns.template_id = templates.id
      ORDER BY campaigns.id DESC
      LIMIT 8
    `),
    allQuery(`
      SELECT messages.*, customers.name AS customer_name, customers.phone
      FROM messages
      LEFT JOIN customers ON messages.customer_id = customers.id
      ORDER BY messages.id DESC
      LIMIT 12
    `),
  ]);

  res.render("dashboard", { counts, campaigns, messages, waState, activePage: "dashboard" });
});

app.get("/customers", async (req, res) => {
  const searchQuery = String(req.query.q ?? "").trim();
  const likeClause =
    `(name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR IFNULL(tags,'') LIKE ? ESCAPE '\\' ` +
    `OR IFNULL(assigned_agent,'') LIKE ? ESCAPE '\\' OR IFNULL(wa_chat_id,'') LIKE ? ESCAPE '\\')`;
  const likePattern = searchQuery ? `%${escapeSqliteLike(searchQuery)}%` : null;

  const requestedPage = Number.parseInt(String(req.query.page || "1"), 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const perPage = 200;
  const counts = await getCounts();

  let totalMatching;
  if (likePattern) {
    const row = await getQuery(`SELECT COUNT(*) AS cnt FROM customers WHERE ${likeClause}`, [
      likePattern,
      likePattern,
      likePattern,
      likePattern,
      likePattern,
    ]);
    totalMatching = Number(row?.cnt ?? 0);
  } else {
    totalMatching = counts.customers || 0;
  }

  const totalPages = Math.max(1, Math.ceil(totalMatching / perPage));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * perPage;

  let customers;
  if (likePattern) {
    customers = await allQuery(
      `SELECT * FROM customers WHERE ${likeClause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [likePattern, likePattern, likePattern, likePattern, likePattern, perPage, offset]
    );
  } else {
    customers = await allQuery("SELECT * FROM customers ORDER BY id DESC LIMIT ? OFFSET ?", [
      perPage,
      offset,
    ]);
  }

  const importSummary = {
    added: Number(req.query.added || 0) || 0,
    skipped: Number(req.query.skipped || 0) || 0,
    invalid: Number(req.query.invalid || 0) || 0,
    source: String(req.query.source || ""),
    error: String(req.query.error || ""),
  };
  const pagination = {
    page: safePage,
    perPage,
    totalPages,
    totalMatching,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
    searchActive: Boolean(likePattern),
  };
  res.render("customers", {
    counts,
    customers,
    importSummary,
    pagination,
    searchQuery,
    activePage: "customers",
  });
});

app.get("/templates", async (req, res) => {
  const [counts, templates] = await Promise.all([
    getCounts(),
    allQuery("SELECT * FROM templates ORDER BY id DESC"),
  ]);
  res.render("templates", { counts, templates, activePage: "templates" });
});

app.get("/campaigns", async (req, res) => {
  const [counts, templates, campaigns] = await Promise.all([
    getCounts(),
    allQuery("SELECT * FROM templates ORDER BY id DESC"),
    allQuery(`
      SELECT campaigns.*, templates.name AS template_name
      FROM campaigns
      JOIN templates ON campaigns.template_id = templates.id
      ORDER BY campaigns.id DESC
    `),
  ]);
  res.render("campaigns", { counts, templates, campaigns, activePage: "campaigns" });
});

app.get("/messages", async (req, res) => {
  const [counts, messages] = await Promise.all([
    getCounts(),
    allQuery(`
      SELECT messages.*, customers.name AS customer_name, customers.phone
      FROM messages
      LEFT JOIN customers ON messages.customer_id = customers.id
      ORDER BY messages.id DESC
      LIMIT 120
    `),
  ]);
  res.render("messages", { counts, messages, activePage: "messages" });
});

app.get("/chatbot", async (req, res) => {
  const [counts, supportBot, faqRules] = await Promise.all([
    getCounts(),
    getSupportBotConfig(),
    allQuery("SELECT * FROM faq_rules ORDER BY id DESC"),
  ]);
  res.render("chatbot", {
    counts,
    supportBot,
    faqRules,
    waState,
    activePage: "chatbot",
  });
});

app.get("/automation", async (req, res) => {
  const [counts, automationRules] = await Promise.all([
    getCounts(),
    allQuery("SELECT * FROM automation_rules ORDER BY id DESC"),
  ]);
  res.render("automation", { counts, automationRules, activePage: "automation" });
});

app.get("/analytics", async (req, res) => {
  const [counts, messageStats, topTags, campaignStats] = await Promise.all([
    getCounts(),
    allQuery(
      "SELECT date(created_at) AS day, SUM(direction='inbound') AS inbound, SUM(direction='outbound') AS outbound FROM messages GROUP BY date(created_at) ORDER BY day DESC LIMIT 7"
    ),
    allQuery(
      "SELECT tags, COUNT(*) AS count FROM customers WHERE tags IS NOT NULL AND tags != '' GROUP BY tags ORDER BY count DESC LIMIT 6"
    ),
    allQuery(
      "SELECT status, COUNT(*) AS count FROM campaigns GROUP BY status ORDER BY count DESC"
    ),
  ]);
  res.render("analytics", { counts, messageStats, topTags, campaignStats, activePage: "analytics" });
});

app.get("/customers/:id", async (req, res) => {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId)) return res.status(400).send("Invalid customer id");

  const [counts, customer, notes, messages] = await Promise.all([
    getCounts(),
    getQuery("SELECT * FROM customers WHERE id = ?", [customerId]),
    allQuery("SELECT * FROM customer_notes WHERE customer_id = ? ORDER BY id DESC", [customerId]),
    allQuery("SELECT * FROM messages WHERE customer_id = ? ORDER BY id DESC LIMIT 60", [customerId]),
  ]);

  if (!customer) return res.status(404).send("Customer not found");
  res.render("customer-detail", { counts, customer, notes, messages, activePage: "customers" });
});

app.post("/customers", async (req, res) => {
  const { name, phone, tags } = req.body;
  if (!name || !phone) return res.status(400).send("name and phone are required");

  try {
    await runQuery(
      "INSERT INTO customers (name, phone, tags) VALUES (?, ?, ?)",
      [name.trim(), phone.trim(), (tags || "").trim()]
    );
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not add customer: ${error.message}`);
  }
});

app.post("/customers/import-csv", (req, res, next) => {
  upload.single("customersCsv")(req, res, (error) => {
    if (!error) return next();
    const source = encodeURIComponent(String(req.body?.source || "upload").trim().slice(0, 80) || "upload");
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return res.redirect(
        `/customers?source=${source}&added=0&skipped=0&invalid=0&error=${encodeURIComponent(
          "CSV file is too large. Max supported size is 50 MB."
        )}`
      );
    }
    return res.redirect(
      `/customers?source=${source}&added=0&skipped=0&invalid=0&error=${encodeURIComponent(
        "Could not read uploaded file."
      )}`
    );
  });
}, async (req, res) => {
  const source = encodeURIComponent(String(req.body.source || "upload").trim().slice(0, 80) || "upload");
  const defaultRedirect = `/customers?source=${source}&added=0&skipped=0&invalid=0`;
  if (!req.file?.buffer) {
    return res.redirect(defaultRedirect);
  }

  try {
    const { prepared, rowErrors } = parseCsvCustomers(req.file.buffer);
    if (!prepared.length) {
      return res.redirect(
        `/customers?source=${source}&added=0&skipped=0&invalid=${encodeURIComponent(rowErrors.length)}`
      );
    }

    const batchSeen = new Set();
    let added = 0;
    let skipped = 0;

    await runQuery("BEGIN TRANSACTION");
    try {
      for (const customer of prepared) {
        if (batchSeen.has(customer.phone)) {
          skipped += 1;
          continue;
        }
        batchSeen.add(customer.phone);
        const result = await runQuery("INSERT OR IGNORE INTO customers (name, phone, tags) VALUES (?, ?, ?)", [
          customer.name,
          customer.phone,
          customer.tags,
        ]);
        if (result.changes > 0) {
          added += 1;
        } else {
          skipped += 1;
        }
      }
      await runQuery("COMMIT");
    } catch (insertError) {
      await runQuery("ROLLBACK");
      throw insertError;
    }

    const invalid = rowErrors.length;
    return res.redirect(
      `/customers?source=${source}&added=${added}&skipped=${skipped}&invalid=${invalid}`
    );
  } catch (error) {
    return res.redirect(
      `/customers?source=${source}&added=0&skipped=0&invalid=0&error=${encodeURIComponent(
        `Could not import CSV: ${error.message}`
      )}`
    );
  }
});

app.post("/customers/:id/delete", async (req, res) => {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId)) return res.status(400).send("Invalid customer id");

  try {
    await runQuery("DELETE FROM messages WHERE customer_id = ?", [customerId]);
    await runQuery("DELETE FROM customers WHERE id = ?", [customerId]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not delete customer: ${error.message}`);
  }
});

app.post("/customers/:id/update", async (req, res) => {
  const customerId = Number(req.params.id);
  const { name, phone, tags } = req.body;
  if (!Number.isInteger(customerId)) return res.status(400).send("Invalid customer id");
  if (!name || !phone) return res.status(400).send("name and phone are required");

  try {
    await runQuery("UPDATE customers SET name = ?, phone = ?, tags = ? WHERE id = ?", [
      name.trim(),
      phone.trim(),
      (tags || "").trim(),
      customerId,
    ]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not update customer: ${error.message}`);
  }
});

app.post("/customers/:id/assign", async (req, res) => {
  const customerId = Number(req.params.id);
  const assignedAgent = String(req.body.assignedAgent || "").trim();
  if (!Number.isInteger(customerId)) return res.status(400).send("Invalid customer id");
  try {
    await runQuery("UPDATE customers SET assigned_agent = ? WHERE id = ?", [assignedAgent, customerId]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not assign agent: ${error.message}`);
  }
});

app.post("/customers/:id/opt-out", async (req, res) => {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId)) return res.status(400).send("Invalid customer id");
  try {
    await runQuery("UPDATE customers SET is_opted_out = 1 WHERE id = ?", [customerId]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not opt out customer: ${error.message}`);
  }
});

app.post("/customers/:id/opt-in", async (req, res) => {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId)) return res.status(400).send("Invalid customer id");
  try {
    await runQuery("UPDATE customers SET is_opted_out = 0 WHERE id = ?", [customerId]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not opt in customer: ${error.message}`);
  }
});

app.post("/customers/:id/notes", async (req, res) => {
  const customerId = Number(req.params.id);
  const note = String(req.body.note || "").trim();
  if (!Number.isInteger(customerId)) return res.status(400).send("Invalid customer id");
  if (!note) return res.status(400).send("Note cannot be empty");
  try {
    await runQuery("INSERT INTO customer_notes (customer_id, note) VALUES (?, ?)", [customerId, note]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not add note: ${error.message}`);
  }
});

app.post("/notes/:id/delete", async (req, res) => {
  const noteId = Number(req.params.id);
  if (!Number.isInteger(noteId)) return res.status(400).send("Invalid note id");
  try {
    await runQuery("DELETE FROM customer_notes WHERE id = ?", [noteId]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not delete note: ${error.message}`);
  }
});

app.post("/customers/delete-all", async (req, res) => {
  try {
    await runQuery("DELETE FROM messages");
    await runQuery("DELETE FROM customers");
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not delete all customer data: ${error.message}`);
  }
});

app.post("/templates", (req, res, next) => {
  templateImageUpload.single("templateImage")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).send("Template image exceeds 12 MB.");
    }
    return res.status(400).send(err.message || "Upload failed.");
  });
}, async (req, res) => {
  const { name, content } = req.body;
  if (!name || !content) {
    if (req.file?.filename) unlinkTemplateImageByRelative(storedRelPathFromTemplateFilename(req.file.filename));
    return res.status(400).send("name and content are required");
  }

  const imagePath = req.file ? storedRelPathFromTemplateFilename(req.file.filename) : "";

  try {
    await runQuery("INSERT INTO templates (name, content, image_path) VALUES (?, ?, ?)", [
      name.trim(),
      content.trim(),
      imagePath,
    ]);
    redirectBack(req, res);
  } catch (error) {
    if (req.file?.path) unlinkTemplateImageByRelative(storedRelPathFromTemplateFilename(req.file.filename));
    res.status(400).send(`Could not add template: ${error.message}`);
  }
});

app.post("/templates/:id/update", (req, res, next) => {
  templateImageUpload.single("templateImage")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).send("Template image exceeds 12 MB.");
    }
    return res.status(400).send(err.message || "Upload failed.");
  });
}, async (req, res) => {
  const templateId = Number(req.params.id);
  const { name, content } = req.body;
  if (!Number.isInteger(templateId)) return res.status(400).send("Invalid template id");
  if (!name || !content) return res.status(400).send("name and content are required");

  try {
    const existing = await getQuery("SELECT * FROM templates WHERE id = ?", [templateId]);
    if (!existing) {
      if (req.file?.filename) unlinkTemplateImageByRelative(storedRelPathFromTemplateFilename(req.file.filename));
      return res.status(404).send("Template not found");
    }

    let image_path = existing.image_path || "";

    if (req.body.removeImage === "on") {
      unlinkTemplateImageByRelative(image_path);
      image_path = "";
    }

    if (req.file?.filename) {
      unlinkTemplateImageByRelative(existing.image_path);
      image_path = storedRelPathFromTemplateFilename(req.file.filename);
    }

    await runQuery("UPDATE templates SET name = ?, content = ?, image_path = ? WHERE id = ?", [
      name.trim(),
      content.trim(),
      image_path || "",
      templateId,
    ]);
    redirectBack(req, res);
  } catch (error) {
    if (req.file?.filename) unlinkTemplateImageByRelative(storedRelPathFromTemplateFilename(req.file.filename));
    res.status(400).send(`Could not update template: ${error.message}`);
  }
});

app.post("/templates/:id/delete", async (req, res) => {
  const templateId = Number(req.params.id);
  if (!Number.isInteger(templateId)) return res.status(400).send("Invalid template id");

  try {
    const existing = await getQuery("SELECT image_path FROM templates WHERE id = ?", [templateId]);
    if (existing?.image_path) unlinkTemplateImageByRelative(existing.image_path);
    await runQuery("DELETE FROM templates WHERE id = ?", [templateId]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not delete template: ${error.message}`);
  }
});

app.post("/templates/delete-all", async (req, res) => {
  try {
    const rows = await allQuery("SELECT image_path FROM templates WHERE TRIM(IFNULL(image_path,'')) != ''");
    for (const row of rows) {
      unlinkTemplateImageByRelative(row.image_path);
    }
    await runQuery("DELETE FROM templates");
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not delete all templates: ${error.message}`);
  }
});

app.post("/send-bulk", async (req, res) => {
  const { templateId, tagFilter, scheduleAt } = req.body;
  if (!templateId) return res.status(400).send("templateId is required");

  const template = await getQuery("SELECT * FROM templates WHERE id = ?", [templateId]);
  if (!template) return res.status(404).send("Template not found");
  const isScheduled = Boolean(scheduleAt && scheduleAt.trim());
  const status = isScheduled ? "scheduled" : "queued";

  const campaign = await runQuery(
    "INSERT INTO campaigns (template_id, customer_count, status, scheduled_at, tag_filter) VALUES (?, ?, ?, ?, ?)",
    [template.id, 0, status, isScheduled ? scheduleAt : null, (tagFilter || "").trim()]
  );

  if (!isScheduled) {
    await processCampaign(campaign.lastID);
  }

  redirectBack(req, res);
});

app.post("/campaigns/:id/delete", async (req, res) => {
  const campaignId = Number(req.params.id);
  if (!Number.isInteger(campaignId)) return res.status(400).send("Invalid campaign id");

  try {
    await runQuery("DELETE FROM campaigns WHERE id = ?", [campaignId]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not delete campaign: ${error.message}`);
  }
});

app.post("/campaigns/delete-all", async (req, res) => {
  try {
    await runQuery("DELETE FROM campaigns");
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not delete all campaigns: ${error.message}`);
  }
});

app.post("/messages/:id/delete", async (req, res) => {
  const messageId = Number(req.params.id);
  if (!Number.isInteger(messageId)) return res.status(400).send("Invalid message id");

  try {
    await runQuery("DELETE FROM messages WHERE id = ?", [messageId]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not delete message: ${error.message}`);
  }
});

app.post("/messages/delete-all", async (req, res) => {
  try {
    await runQuery("DELETE FROM messages");
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not delete all messages: ${error.message}`);
  }
});

app.post("/support-bot/update", async (req, res) => {
  const enabled = req.body.enabled === "on" ? 1 : 0;
  const fallbackReply = String(req.body.fallbackReply || "").trim();
  if (!fallbackReply) return res.status(400).send("Fallback reply is required");

  try {
    await runQuery("UPDATE support_bot_config SET enabled = ?, fallback_reply = ? WHERE id = 1", [
      enabled,
      fallbackReply,
    ]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not update support bot config: ${error.message}`);
  }
});

app.post("/faq", async (req, res) => {
  const questionKeywords = String(req.body.questionKeywords || "").trim();
  const answer = String(req.body.answer || "").trim();
  const isActive = req.body.isActive === "on" ? 1 : 0;
  if (!questionKeywords || !answer) return res.status(400).send("keywords and answer are required");

  try {
    await runQuery("INSERT INTO faq_rules (question_keywords, answer, is_active) VALUES (?, ?, ?)", [
      questionKeywords,
      answer,
      isActive,
    ]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not add FAQ: ${error.message}`);
  }
});

app.post("/faq/:id/update", async (req, res) => {
  const faqId = Number(req.params.id);
  const questionKeywords = String(req.body.questionKeywords || "").trim();
  const answer = String(req.body.answer || "").trim();
  const isActive = req.body.isActive === "on" ? 1 : 0;
  if (!Number.isInteger(faqId)) return res.status(400).send("Invalid FAQ id");
  if (!questionKeywords || !answer) return res.status(400).send("keywords and answer are required");

  try {
    await runQuery("UPDATE faq_rules SET question_keywords = ?, answer = ?, is_active = ? WHERE id = ?", [
      questionKeywords,
      answer,
      isActive,
      faqId,
    ]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not update FAQ: ${error.message}`);
  }
});

app.post("/faq/:id/delete", async (req, res) => {
  const faqId = Number(req.params.id);
  if (!Number.isInteger(faqId)) return res.status(400).send("Invalid FAQ id");

  try {
    await runQuery("DELETE FROM faq_rules WHERE id = ?", [faqId]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not delete FAQ: ${error.message}`);
  }
});

app.post("/faq/delete-all", async (req, res) => {
  try {
    await runQuery("DELETE FROM faq_rules");
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not delete FAQs: ${error.message}`);
  }
});

app.post("/automation", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const triggerKeyword = String(req.body.triggerKeyword || "").trim().toLowerCase();
  const replyTemplate = String(req.body.replyTemplate || "").trim();
  const isActive = req.body.isActive === "on" ? 1 : 0;
  if (!name || !triggerKeyword || !replyTemplate) {
    return res.status(400).send("name, trigger keyword and reply are required");
  }

  try {
    await runQuery(
      "INSERT INTO automation_rules (name, trigger_keyword, reply_template, is_active) VALUES (?, ?, ?, ?)",
      [name, triggerKeyword, replyTemplate, isActive]
    );
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not add automation rule: ${error.message}`);
  }
});

app.post("/automation/:id/update", async (req, res) => {
  const ruleId = Number(req.params.id);
  const name = String(req.body.name || "").trim();
  const triggerKeyword = String(req.body.triggerKeyword || "").trim().toLowerCase();
  const replyTemplate = String(req.body.replyTemplate || "").trim();
  const isActive = req.body.isActive === "on" ? 1 : 0;
  if (!Number.isInteger(ruleId)) return res.status(400).send("Invalid rule id");
  if (!name || !triggerKeyword || !replyTemplate) {
    return res.status(400).send("name, trigger keyword and reply are required");
  }

  try {
    await runQuery(
      "UPDATE automation_rules SET name = ?, trigger_keyword = ?, reply_template = ?, is_active = ? WHERE id = ?",
      [name, triggerKeyword, replyTemplate, isActive, ruleId]
    );
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not update automation rule: ${error.message}`);
  }
});

app.post("/automation/:id/delete", async (req, res) => {
  const ruleId = Number(req.params.id);
  if (!Number.isInteger(ruleId)) return res.status(400).send("Invalid rule id");
  try {
    await runQuery("DELETE FROM automation_rules WHERE id = ?", [ruleId]);
    redirectBack(req, res);
  } catch (error) {
    res.status(400).send(`Could not delete automation rule: ${error.message}`);
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    whatsappReady: waState.isReady,
    lastQrAt: waState.lastQrAt,
    lastError: waState.lastError,
    hasQr: Boolean(waState.qrDataUrl),
  });
});

app.post("/whatsapp/logout", async (req, res) => {
  try {
    waState.isReady = false;
    waState.lastError = null;
    await waClient.logout();
    await waClient.initialize();
    redirectBack(req, res);
  } catch (error) {
    waState.lastError = `Logout failed: ${error.message}`;
    res.status(400).send(waState.lastError);
  }
});

waClient.on("qr", async (qr) => {
  waState.isReady = false;
  waState.lastQrAt = new Date().toISOString();
  waState.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
  emitRealtime("whatsapp:qr");
  qrcodeTerminal.generate(qr, { small: true });
  // eslint-disable-next-line no-console
  console.log("Scan the QR code above with WhatsApp > Linked Devices.");
});

waClient.on("ready", () => {
  waState.isReady = true;
  waState.lastError = null;
  waState.qrDataUrl = null;
  emitRealtime("whatsapp:ready");
  // eslint-disable-next-line no-console
  console.log("WhatsApp Web client is ready.");
});

waClient.on("auth_failure", (msg) => {
  waState.isReady = false;
  waState.lastError = msg || "Authentication failed";
  waState.qrDataUrl = null;
  emitRealtime("whatsapp:error", { message: waState.lastError });
  // eslint-disable-next-line no-console
  console.error("WhatsApp auth failure:", msg);
});

waClient.on("disconnected", (reason) => {
  waState.isReady = false;
  waState.lastError = reason || "Disconnected";
  waState.qrDataUrl = null;
  emitRealtime("whatsapp:disconnected", { message: waState.lastError });
  // eslint-disable-next-line no-console
  console.error("WhatsApp disconnected:", reason);
});

waClient.on("message", async (message) => {
  try {
    if (!message.from || !message.body) return;
    if (message.fromMe) return;
    if (message.from.endsWith("@g.us") || message.from === "status@broadcast") return;

    const from = String(message.from).replace(/@(c\.us|lid)$/i, "");
    const text = message.body;
    let contactName = "New Customer";
    try {
      const contact = await message.getContact();
      contactName =
        contact?.pushname ||
        contact?.name ||
        contact?.shortName ||
        message?._data?.notifyName ||
        "New Customer";
    } catch (error) {
      contactName = message?._data?.notifyName || "New Customer";
    }

    let customer = await getQuery("SELECT * FROM customers WHERE phone = ?", [from]);

    if (!customer) {
      const insert = await runQuery(
        "INSERT INTO customers (name, phone, tags, wa_chat_id) VALUES (?, ?, ?, ?)",
        [contactName, from, "inbound", message.from]
      );
      customer = { id: insert.lastID, name: contactName, phone: from };
    } else if (contactName && customer.name === "New Customer") {
      await runQuery("UPDATE customers SET name = ? WHERE id = ?", [contactName, customer.id]);
      customer.name = contactName;
    }

    if (String(customer.wa_chat_id || "") !== String(message.from || "")) {
      await runQuery("UPDATE customers SET wa_chat_id = ? WHERE id = ?", [message.from, customer.id]);
      customer.wa_chat_id = message.from;
    }

    await runQuery(
      "INSERT INTO messages (customer_id, direction, body, wa_message_id, status) VALUES (?, ?, ?, ?, ?)",
      [customer.id, "inbound", text, message.id?._serialized || null, "received"]
    );
    emitRealtime("message:inbound");

    const normalizedText = String(text || "").toLowerCase().trim();
    const optOutKeywords = ["stop", "unsubscribe", "opt out", "remove me"];
    if (optOutKeywords.some((keyword) => normalizedText.includes(keyword))) {
      await runQuery("UPDATE customers SET is_opted_out = 1 WHERE id = ?", [customer.id]);
      const optOutReply =
        "You have been unsubscribed from marketing messages. Reply START anytime to opt back in.";
      const sent = await message.reply(optOutReply);
      await runQuery(
        "INSERT INTO messages (customer_id, direction, body, wa_message_id, status) VALUES (?, ?, ?, ?, ?)",
        [customer.id, "outbound", optOutReply, sent.id?._serialized || null, "sent"]
      );
      emitRealtime("customer:opted_out");
      return;
    }

    if (normalizedText === "start") {
      await runQuery("UPDATE customers SET is_opted_out = 0 WHERE id = ?", [customer.id]);
    }

    const automationRules = await allQuery("SELECT * FROM automation_rules WHERE is_active = 1");
    const matchingAutomation = automationRules.find((rule) =>
      normalizedText.includes(String(rule.trigger_keyword || "").toLowerCase())
    );
    if (matchingAutomation) {
      const autoFlowReply = renderTemplate(matchingAutomation.reply_template, customer);
      const sent = await message.reply(autoFlowReply);
      await runQuery(
        "INSERT INTO messages (customer_id, direction, body, wa_message_id, status) VALUES (?, ?, ?, ?, ?)",
        [customer.id, "outbound", autoFlowReply, sent.id?._serialized || null, "sent"]
      );
      emitRealtime("automation:triggered", { ruleId: matchingAutomation.id });
      return;
    }

    const supportBot = await getSupportBotConfig();
    if (supportBot.enabled && !customer.is_opted_out) {
      const faqRules = await allQuery("SELECT * FROM faq_rules WHERE is_active = 1");
      const faqReply = getFaqReply(text, faqRules);
      const autoReply =
        faqReply || getSmartSupportReply(text, customer.name, supportBot.fallback_reply);
      const sent = await message.reply(autoReply);
      await runQuery(
        "INSERT INTO messages (customer_id, direction, body, wa_message_id, status) VALUES (?, ?, ?, ?, ?)",
        [customer.id, "outbound", autoReply, sent.id?._serialized || null, "sent"]
      );
      emitRealtime("message:outbound");
    }
  } catch (error) {
    waState.lastError = error.message;
  }
});

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on http://localhost:${PORT}`);
});

waClient.initialize();
processDueCampaigns().catch((error) => {
  waState.lastError = error.message;
});
setInterval(() => {
  processDueCampaigns().catch((error) => {
    waState.lastError = error.message;
  });
}, 30000);
