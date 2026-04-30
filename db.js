const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");

const db = new sqlite3.Database("./app.db");

db.serialize(() => {
  const defaultAdminUsername = process.env.ADMIN_USERNAME || "admin";
  const defaultAdminPassword = process.env.ADMIN_PASSWORD || "admin123";
  const defaultAdminPasswordHash = bcrypt.hashSync(defaultAdminPassword, 10);

  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'owner',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(
    `
      INSERT OR IGNORE INTO admins (username, password_hash, role)
      VALUES (?, ?, 'owner')
    `,
    [defaultAdminUsername, defaultAdminPasswordHash]
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      tags TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      customer_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'queued',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(template_id) REFERENCES templates(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      direction TEXT NOT NULL,
      body TEXT NOT NULL,
      wa_message_id TEXT,
      status TEXT DEFAULT 'sent',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS support_bot_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER DEFAULT 1,
      fallback_reply TEXT NOT NULL
    )
  `);

  db.run(
    `
      INSERT OR IGNORE INTO support_bot_config (id, enabled, fallback_reply)
      VALUES (1, 1, ?)
    `,
    ["Thanks for contacting support. Our team will get back to you soon."]
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS faq_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_keywords TEXT NOT NULL,
      answer TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS customer_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      note TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS automation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      trigger_keyword TEXT NOT NULL,
      reply_template TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(
    `
      INSERT OR IGNORE INTO automation_rules (id, name, trigger_keyword, reply_template, is_active)
      VALUES (1, 'Re-engage Pricing Leads', 'price', 'Thanks for your interest. Do you want Basic, Pro, or Enterprise plan details?', 1)
    `
  );

  db.run("ALTER TABLE customers ADD COLUMN assigned_agent TEXT DEFAULT ''", () => {});
  db.run("ALTER TABLE customers ADD COLUMN is_opted_out INTEGER DEFAULT 0", () => {});
  db.run("ALTER TABLE customers ADD COLUMN wa_chat_id TEXT DEFAULT ''", () => {});
  db.run("ALTER TABLE campaigns ADD COLUMN scheduled_at DATETIME", () => {});
  db.run("ALTER TABLE campaigns ADD COLUMN tag_filter TEXT DEFAULT ''", () => {});
});

module.exports = db;
