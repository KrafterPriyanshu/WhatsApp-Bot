# WhatsApp Web Bot + Admin Dashboard

This project gives you:
- Bulk marketing messages to customer lists
- Basic customer support auto-replies
- Admin dashboard to manage customers, templates, and campaigns

## 1) Setup

```bash
npm install
copy .env.example .env
```

No official API keys needed. This uses WhatsApp Web session login by QR.

## 2) Run

```bash
npm start
```

Open:
- Dashboard: `http://localhost:3000`

Login defaults (change in `.env`):
- Username: `admin`
- Password: `admin123`

## 3) Connect Your WhatsApp Account

1. Start app: `npm start`
2. In terminal, scan QR code with phone:
   - WhatsApp -> Linked Devices -> Link a Device
3. After scan, dashboard status should show `Connected`

## 4) How to use

1. Add customers with phone numbers in international format (e.g. `9198xxxxxxx`)
2. Create templates (supports `{{name}}` and `{{phone}}`)
3. Send bulk campaign with optional tag filter
4. Incoming messages will be saved in dashboard and receive an auto-reply

## Notes

- Auth system is enabled with session login.
- For high volumes, move campaign sending to a job queue (BullMQ/RabbitMQ).
- Respect WhatsApp anti-spam rules and customer consent.
- WhatsApp Web automation is unofficial and may be unstable for high scale.
