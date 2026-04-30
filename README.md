# WhatsApp Bot — Marketing, Support & Admin Dashboard

An **unofficial WhatsApp Web** assistant built with **[whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)** (not Meta’s WhatsApp Cloud API). It includes a browser-based dashboard for contacts, campaigns, templates, FAQs, automation, and inbound message logging.

---

## Features

| Area | What it does |
|------|----------------|
| **WhatsApp linking** | Log in via **QR code** (same as WhatsApp Desktop / Linked Devices). Session is stored under `.wwebjs_auth`. |
| **Customers** | Add manually; **CSV import** (bulk); auto-create contact on first **inbound** message; tags, assigned agent, opt-in/opt-out, notes; **search** (name, phone, tags, agent, chat id); **pagination** on the list page. |
| **Templates** | Message bodies with placeholders `{{name}}` and `{{phone}}` for campaigns. Starter templates are seeded on first DB init (see [Default templates](#default-templates)); more [copy-paste examples](#example-message-templates-copy-paste) below. |
| **Campaigns** | Send bulk messages from a chosen template; optional **tag filter**; **immediate** send or **scheduled** time (SQLite `datetime('now')` — use **UTC-compatible** timestamps for reliability). |
| **Messages** | Inbound/outbound history linked to customers. |
| **Support bot** | Toggle auto-replies; editable fallback text; FAQ keyword rules stored in SQLite. |
| **Automation rules** | Keyword triggers with templated replies (also supports `{{name}}` / `{{phone}}`). |
| **Dashboard** | Counts, recent campaigns/messages; **Socket.io** pushes refresh hints after mutations. |
| **Health** | `GET /health` — JSON with WhatsApp ready state / QR hints (authenticated session still required for most routes except `/login` and `/health`). |

---

## Tech stack

- **Runtime:** Node.js (CommonJS)
- **Server:** Express 5, `express-session`, `body-parser`
- **Realtime:** Socket.io (attached to the same HTTP server)
- **Views:** EJS (`views/`), static assets in `public/`
- **Database:** SQLite (`app.db`) via `sqlite3`
- **WhatsApp:** `whatsapp-web.js` + Puppeteer (headless Chromium)
- **CSV import:** `multer`, `csv-parse`
- **Auth:** bcrypt-hashed admins in SQLite

---

## Requirements

- Node.js **18+** recommended (matching your lockfile toolchain)
- A machine capable of running **headless Chromium** (Puppeteer)
- Enough RAM for Puppeteer during WhatsApp sessions

---

## Setup

From the project root:

```bash
npm install
```

Copy the environment template and edit secrets before production:

```bash
copy .env.example .env   # Windows
# cp .env.example .env   # macOS / Linux
```

### Environment variables (`.env`)

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port (default `3000`). |
| `SESSION_SECRET` | Signing secret for Express session cookies. **Set a long random string in production.** |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | First admin bootstrap (stored hashed). Change defaults before exposing the server. |
| `SUPPORT_AUTO_REPLY` | Default fallback text used when initializing support-bot config row. |

> **Important:** WhatsApp linking does **not** use Cloud API tokens; it uses **session login** locally. Protect your `.env`, `app.db`, and `.wwebjs_auth` — they effectively control messaging and contacts.

---

## Run

```bash
npm start
```

Open **`http://localhost:3000`**, log in with the credentials from `.env` (defaults in `.env.example` are `admin` / `admin123` until you change them).

---

## Connect WhatsApp

1. Start the server (`npm start`).
2. In the **terminal**, scan the **QR code** with your phone: **WhatsApp → Settings → Linked Devices → Link a Device**.
3. Wait until logs show **ready** / dashboard WhatsApp section shows connected.

Logout / reconnect is available from the dashboard where implemented (disconnect triggers re-init and a new QR if needed).

---

## CSV import (customers)

On **Customers**:

- **Columns:** **`phone`** (required — digits only after normalization); **`name`** (optional, defaults to `New Customer`); **`tags`** (optional). Columns like **`email`** or **`user_id`** are ignored.
- **Duplicates:** Rows with no phone after stripping non-digits are skipped. Duplicate phone numbers in the file are skipped after the first. Phones already in the database are skipped (`INSERT OR IGNORE`).
- **File size:** Large uploads are capped in code (currently **50 MB**); split very large files if needed.

---

## Campaigns & templates

1. Ensure WhatsApp Web client is **ready** (otherwise sends fail).
2. Create or edit **templates** (`{{name}}`, `{{phone}}`).
3. **Campaigns**: pick template; optional tag filter; send now or schedule.

---

## Example message templates (copy-paste)

Use these in **Dashboard → Templates** (create new, paste body, set a short **name** per row). Replace bracketed bits like `[product/service]` or `[invoice/renewal]` with your wording.

### 1. Warm welcome

```
Hi {{name}}, thanks for connecting with us. How can we help you today?
```

### 2. Offer teaser

```
Hi {{name}}! We have something special lined up — reply INTERESTED if you'd like details.
```

### 3. Follow-up after chat

```
Hi {{name}}, following up from earlier. Anything else we can clarify before you decide?
```

### 4. Order / enquiry status

```
Hi {{name}}, we've noted your enquiry (ref: {{phone}}). Our team will update you shortly — thanks for your patience.
```

### 5. Appointment / callback

```
Hi {{name}}, we can call you back at your convenience. Reply with a preferred time slot (today/tomorrow + hours).
```

### 6. Feedback

```
Hi {{name}}, quick ask — rate us 1–5 or reply in one line what we could improve. It really helps.
```

### 7. Reconnect (cold)

```
Hey {{name}}, it's been a while. If you still need [product/service], reply YES and we'll send a short recap.
```

### 8. Payment / renewal (neutral)

```
Hi {{name}}, this is a friendly reminder about [invoice/renewal]. Reply HELP if you need assistance or options.
```

---

## Customer creation (sources)

| Source | Behavior |
|--------|----------|
| Dashboard “Add Customer” | Inserts rows with uniqueness on **phone**. |
| CSV upload | Parsed server-side with summary redirect (`added`, `skipped`, **invalid rows** without phone). |
| Inbound WhatsApp | Creates or updates customer, stores **`wa_chat_id`** for replies. |

---

## Default templates

Six starter templates are inserted with **`INSERT OR IGNORE`** when the DB schema initializes (won’t overwrite if you renamed or deleted matching names deliberately — unique constraint is on **`name`**). Rename or duplicate in-app as needed:

1. **Welcome — New Lead** — first-touch greeting  
2. **Promotion — Flash Offer** — short offer blurb  
3. **Follow-up — After Inquiry** — gentle follow-up  
4. **Appointment — Reminder** — reminder wording  
5. **Feedback — Quick Survey** — request quick feedback  
6. **Reconnect — Win-back** — re-engagement for quiet leads  

Full text lives in **`db.js`** as seed inserts.

---

## Project layout (main files)

```
server.js       # Express app, WhatsApp client, campaigns, inbound handler
db.js           # SQLite schema migrations + seeds (admin, FAQ seeds, automation, templates)
app.db          # Local database file (generated / grows with use)
views/          # EJS templates
public/         # CSS + client JS (Socket.io subscriber)
.env / .env.example
```

---

## Compliance & operations

- **Consent:** Import and message only contacts who opted in where your jurisdiction requires it.
- **Anti-spam:** Space bulk sends and avoid unsolicited marketing; bans on WhatsApp or account limitations are possible with automation misuse.
- **Unofficial stack:** WhatsApp Web automation can break after WhatsApp web updates; Puppeteer/Chromium quirks may need tuning on servers.
- **Scaling:** Heavy sending should move to queued workers (e.g. BullMQ) outside this codebase; current flow processes campaigns **sequentially**.

---

## Scripts

```json
"start": "node server.js",
"dev": "node server.js"
```

---

## Troubleshooting

| Symptom | Check |
|---------|------|
| QR not showing | Terminal output / logs; Chromium sandbox flags on Linux servers (`--no-sandbox` already in server). |
| Send fails (“not ready”) | Complete QR scan; check `/health`. |
| Import shows fewer rows than spreadsheet | Rows **without** a phone column; duplicates; numbers **already** in DB. |
| Scheduled campaign wrong time | Use UTC-friendly `scheduled_at` or align with SQLite `datetime('now')` behavior. |

---

## License

`ISC` (see `package.json`). Third-party libs (whatsapp-web.js, Puppeteer, etc.) have their own licenses.
