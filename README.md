# SkyScout Backend — Autonomous Flight Price Agent

A production-ready Node.js backend that autonomously monitors flight prices,
runs an AI agent (Claude + web search) on a schedule, and notifies users
when prices drop below their alert thresholds.

---

## Architecture

```
Frontend (HTML/React)
      │  REST API + Socket.IO
      ▼
Express Server (src/index.js)
  ├── Auth routes       → JWT login/register
  ├── Alert routes      → CRUD for price alerts
  ├── Notification routes → read/mark alerts
  └── Socket.IO         → real-time browser push
         │
         ▼
Cron Job (every 30min)
  └── For each due alert:
        1. Call Claude AI agent + web_search
        2. Parse best deals + prices
        3. Save PricePoint to Postgres
        4. If deal threshold hit → notify
             ├── Email (Resend)
             ├── SMS (Twilio)
             └── Browser push (Socket.IO)
         │
         ▼
PostgreSQL (via Prisma ORM)
  ├── users
  ├── alerts
  ├── price_points  (time-series)
  └── notifications
```

---

## Quick Start

### 1. Clone and install

```bash
git clone <your-repo>
cd skyscout-backend
npm install
```

### 2. Set up PostgreSQL (free options)

**Option A — Neon (recommended, serverless)**
1. Go to https://neon.tech and create a free account
2. Create a project → copy the connection string
3. Paste it as `DATABASE_URL` in your `.env`

**Option B — Supabase**
1. Go to https://supabase.com → new project
2. Settings → Database → copy connection string (use "Transaction pooler" mode)

**Option C — Local Docker**
```bash
docker run -d \
  -e POSTGRES_DB=skyscout \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 postgres:16
# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/skyscout
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your actual keys
```

Minimum required for local dev:
- `DATABASE_URL` — your Postgres connection string
- `JWT_SECRET` — any random string (run `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`)
- `ANTHROPIC_API_KEY` — from https://console.anthropic.com

Optional (notifications won't work without these but everything else will):
- `RESEND_API_KEY` — email alerts (https://resend.com, free tier: 3,000 emails/mo)
- `TWILIO_*` — SMS alerts (https://twilio.com)

### 4. Run database migrations

```bash
npm run db:migrate    # creates tables
npm run db:seed       # adds demo user + sample alerts
```

### 5. Start the server

```bash
npm run dev           # development (auto-restarts)
npm start             # production
```

Server starts on http://localhost:3001

---

## API Reference

### Auth
```
POST /api/auth/register   { email, password, name?, phone? }
POST /api/auth/login      { email, password }
GET  /api/auth/me         — requires Bearer token
```

### Alerts
```
GET    /api/alerts                — list all your alerts
POST   /api/alerts                — create alert
GET    /api/alerts/:id            — get alert + price history
PATCH  /api/alerts/:id            — update (pause, change settings)
DELETE /api/alerts/:id            — delete alert
POST   /api/alerts/:id/check-now  — trigger immediate price check
```

#### Create alert payload
```json
{
  "origin": "New York (JFK)",
  "dest": "London (LHR)",
  "originCode": "JFK",
  "destCode": "LHR",
  "departDate": "2026-07-06",
  "returnDate": "2026-07-13",
  "cabin": "ECONOMY",
  "passengers": 1,
  "maxBudget": 1000,
  "targetDrop": 10,
  "checkFreq": 6,
  "channels": ["email", "browser", "sms"]
}
```

### Notifications
```
GET   /api/notifications              — list notifications
GET   /api/notifications?unread=true  — unread only
PATCH /api/notifications/:id/read     — mark one read
PATCH /api/notifications/read-all     — mark all read
```

### Real-time (Socket.IO)
```js
const socket = io('http://localhost:3001');

// Authenticate immediately after connecting
socket.on('connect', () => {
  socket.emit('authenticate', yourJwtToken);
});

// Listen for real-time events
socket.on('notification', (data) => {
  // { type: 'DEAL_FOUND', notif: {...} }
});

socket.on('check_result', (data) => {
  // { alertId, result: { bestPrice, deals, timing } }
});
```

---

## Connecting the Frontend

In your `skyscout-agent.html`, replace the mock data functions with real API calls:

```js
const API = 'http://localhost:3001';  // or your deployed URL
let token = localStorage.getItem('token');

// Login
const { data } = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
}).then(r => r.json());
token = data.token;
localStorage.setItem('token', token);

// Fetch alerts
const alerts = await fetch(`${API}/api/alerts`, {
  headers: { Authorization: `Bearer ${token}` },
}).then(r => r.json());

// Create alert
const alert = await fetch(`${API}/api/alerts`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(alertPayload),
}).then(r => r.json());

// Real-time
import { io } from 'https://cdn.socket.io/4.8.1/socket.io.esm.min.js';
const socket = io(API);
socket.on('connect', () => socket.emit('authenticate', token));
socket.on('notification', (data) => showToast(data));
```

---

## Deploying to Production

### Recommended stack (all have free tiers)

| Layer | Service | Cost |
|---|---|---|
| Server | Railway / Render / Fly.io | Free → $5/mo |
| Database | Neon (serverless Postgres) | Free tier |
| Email | Resend | 3,000 emails/mo free |
| SMS | Twilio | Pay-as-you-go |
| Domain | Namecheap | ~$10/yr |

### Deploy to Railway (easiest)

```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway variables set ANTHROPIC_API_KEY=... JWT_SECRET=... DATABASE_URL=...
```

### Deploy to Render

1. Push to GitHub
2. New Web Service → connect repo
3. Build command: `npm install && npm run db:migrate`
4. Start command: `npm start`
5. Add environment variables in dashboard

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `JWT_SECRET` | ✅ | Secret for JWT signing |
| `ANTHROPIC_API_KEY` | ✅ | Claude API key |
| `RESEND_API_KEY` | Optional | Email notifications |
| `EMAIL_FROM` | Optional | Sender address |
| `TWILIO_ACCOUNT_SID` | Optional | SMS notifications |
| `TWILIO_AUTH_TOKEN` | Optional | SMS notifications |
| `TWILIO_PHONE_NUMBER` | Optional | SMS sender number |
| `FRONTEND_URL` | Optional | CORS allow origin |
| `PORT` | Optional | Server port (default 3001) |
| `CRON_INTERVAL_MINUTES` | Optional | Poll frequency (default 30) |

---

## Demo Credentials (after seeding)
- Email: `demo@skyscout.app`
- Password: `demo1234`
