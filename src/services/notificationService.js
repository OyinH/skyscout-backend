// src/services/notificationService.js
import { Resend } from 'resend';
import twilio from 'twilio';
import { prisma } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// In-memory store of Socket.IO connections keyed by userId
// Populated by socket.io setup in index.js
export const socketsByUser = new Map();

// ─── MAIN DISPATCHER ──────────────────────────────────────────────────────────

/**
 * Send a deal notification through all channels the user configured.
 *
 * @param {object} alert  - Prisma Alert (with user relation)
 * @param {object} deal   - Best deal from agent
 * @param {object} result - Full agent result
 */
export async function sendDealNotification(alert, deal, result) {
  const user = alert.user;
  const channels = alert.channels.split(',').map(c => c.trim());
  const sentVia = [];

  const title = `✈ Deal alert: ${alert.originCode} → ${alert.destCode} — $${deal.price.toLocaleString()}`;
  const message = `${deal.airline} — ${deal.savingsPct}% off. Was $${deal.normalPrice}, now $${deal.price}. ${deal.reason}`;

  // 1. Save notification to DB
  const notif = await prisma.notification.create({
    data: {
      userId: user.id,
      alertId: alert.id,
      type: 'DEAL_FOUND',
      title,
      message,
      data: { deal, result },
      sentVia: [],
    },
  });

  // 2. Email
  if (channels.includes('email') && user.email) {
    const ok = await sendEmail(user.email, alert, deal, result);
    if (ok) sentVia.push('email');
  }

  // 3. SMS
  if (channels.includes('sms') && user.phone) {
    const ok = await sendSMS(user.phone, alert, deal);
    if (ok) sentVia.push('sms');
  }

  // 4. Browser push (WebSocket)
  if (channels.includes('browser')) {
    const ok = pushToSocket(user.id, { type: 'DEAL_FOUND', notif });
    if (ok) sentVia.push('browser');
  }

  // Update sentVia on the notification record
  await prisma.notification.update({
    where: { id: notif.id },
    data: { sentVia },
  });

  logger.info(`📬 Notified ${user.email} via [${sentVia.join(', ')}] for ${alert.originCode}→${alert.destCode}`);
  return sentVia;
}

// ─── PRICE-CHANGE NOTIFICATION (non-deal, FYI update) ────────────────────────

export async function sendPriceUpdateNotification(alert, oldPrice, newPrice) {
  const user = alert.user;
  const diff = newPrice - oldPrice;
  const dir = diff > 0 ? '↑' : '↓';
  const title = `${dir} Price update: ${alert.originCode} → ${alert.destCode}`;
  const message = `Price ${diff > 0 ? 'rose' : 'dropped'} $${Math.abs(diff)} to $${newPrice.toLocaleString()} (${alert.cabin.toLowerCase()}).`;

  await prisma.notification.create({
    data: {
      userId: user.id,
      alertId: alert.id,
      type: 'PRICE_DROP',
      title,
      message,
      sentVia: ['browser'],
    },
  });

  pushToSocket(user.id, {
    type: 'PRICE_UPDATE',
    alertId: alert.id,
    oldPrice,
    newPrice,
    message,
  });
}

// ─── EMAIL ────────────────────────────────────────────────────────────────────

async function sendEmail(to, alert, deal, result) {
  if (!resend) {
    logger.warn('Email skipped — RESEND_API_KEY not configured');
    return false;
  }

  const savingsTotal = (deal.normalPrice - deal.price) * alert.passengers;
  const buyNowColor = result.timing?.buyNow ? '#4ade80' : '#fbbf24';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin:0; padding:0; background:#09090f; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
    .wrap { max-width:600px; margin:0 auto; padding:32px 16px; }
    .card { background:#111118; border:1px solid rgba(255,255,255,0.08); border-radius:16px; overflow:hidden; }
    .header { background:linear-gradient(135deg,#0f2027,#203a43,#2c5364); padding:32px; text-align:center; }
    .logo { font-size:22px; font-weight:800; color:#fff; letter-spacing:-0.5px; margin-bottom:6px; }
    .logo span { color:#4ade80; }
    .eyebrow { font-size:12px; color:rgba(255,255,255,0.5); text-transform:uppercase; letter-spacing:.1em; }
    .body { padding:28px; }
    .route { font-size:28px; font-weight:800; color:#eef0f6; text-align:center; margin-bottom:6px; }
    .route span { color:#818cf8; }
    .price-block { text-align:center; margin:24px 0; }
    .price { font-size:56px; font-weight:800; color:#4ade80; line-height:1; }
    .price-sub { font-size:14px; color:rgba(255,255,255,0.4); margin-top:4px; }
    .savings-pill { display:inline-block; background:rgba(74,222,128,0.12); border:1px solid rgba(74,222,128,0.3); color:#4ade80; border-radius:20px; padding:6px 16px; font-size:13px; font-weight:600; margin-top:10px; }
    .meta-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:24px 0; }
    .meta-item { background:#18181f; border-radius:10px; padding:14px; }
    .meta-label { font-size:10px; color:rgba(255,255,255,0.35); text-transform:uppercase; letter-spacing:.06em; margin-bottom:4px; }
    .meta-val { font-size:14px; font-weight:600; color:#eef0f6; }
    .cta { display:block; background:#4ade80; color:#09090f; text-align:center; padding:16px; border-radius:10px; font-size:15px; font-weight:800; text-decoration:none; margin:24px 0; }
    .timing-box { background:#18181f; border-left:3px solid ${buyNowColor}; border-radius:0 10px 10px 0; padding:14px 16px; margin:16px 0; }
    .timing-box .t-label { font-size:11px; color:rgba(255,255,255,0.4); margin-bottom:4px; }
    .timing-box .t-val { font-size:14px; color:#eef0f6; }
    .flex-tip { background:rgba(251,191,36,0.06); border:1px solid rgba(251,191,36,0.15); border-radius:10px; padding:12px 14px; font-size:13px; color:rgba(255,255,255,0.6); margin:12px 0; }
    .flex-tip strong { color:#fbbf24; }
    .footer { padding:20px 28px; border-top:1px solid rgba(255,255,255,0.06); font-size:12px; color:rgba(255,255,255,0.25); text-align:center; }
    .btn-manage { display:inline-block; margin-top:8px; color:rgba(255,255,255,0.3); text-decoration:underline; font-size:12px; }
  </style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="header">
      <div class="logo">Sky<span>Scout</span></div>
      <div class="eyebrow">Deal alert found</div>
    </div>
    <div class="body">
      <div class="route">${alert.origin} <span>→</span> ${alert.dest}</div>

      <div class="price-block">
        <div class="price">$${deal.price.toLocaleString()}</div>
        <div class="price-sub">per person · round trip · ${alert.cabin.toLowerCase()} class</div>
        <div class="savings-pill">Save $${savingsTotal.toLocaleString()} vs normal price (-${deal.savingsPct}%)</div>
      </div>

      <div class="meta-grid">
        <div class="meta-item">
          <div class="meta-label">Airline</div>
          <div class="meta-val">${deal.airline}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Stops</div>
          <div class="meta-val">${deal.stops === 0 ? 'Nonstop ✓' : deal.stops + ' stop'}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Duration</div>
          <div class="meta-val">${Math.floor(deal.durationMinutes / 60)}h ${deal.durationMinutes % 60}m</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Deal score</div>
          <div class="meta-val" style="color:#4ade80">${deal.dealScore}/100</div>
        </div>
      </div>

      <a href="${deal.bookingUrl}" class="cta">Book on ${deal.airline} →</a>

      <div class="timing-box">
        <div class="t-label">${result.timing?.buyNow ? '✅ Buy now' : '⏳ Timing advice'}</div>
        <div class="t-val">${result.timing?.buyNowReason || 'Monitor this price closely.'}</div>
      </div>

      ${result.timing?.flexTip ? `
      <div class="flex-tip">
        <strong>Flex tip:</strong> ${result.timing.flexTip}
      </div>` : ''}
    </div>
    <div class="footer">
      You're receiving this because you set a price alert on SkyScout.<br>
      <a href="${process.env.FRONTEND_URL}/alerts/${alert.id}" class="btn-manage">Manage this alert</a>
    </div>
  </div>
</div>
</body>
</html>`;

  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'alerts@skyscout.app',
      to,
      subject: `✈ Deal: ${alert.originCode}→${alert.destCode} $${deal.price} (${deal.savingsPct}% off)`,
      html,
    });
    return true;
  } catch (err) {
    logger.error(`Email send failed: ${err.message}`);
    return false;
  }
}

// ─── SMS ──────────────────────────────────────────────────────────────────────

async function sendSMS(to, alert, deal) {
  if (!twilioClient) {
    logger.warn('SMS skipped — Twilio not configured');
    return false;
  }

  const msg = `✈ SkyScout Deal! ${alert.originCode}→${alert.destCode}: $${deal.price} (${deal.savingsPct}% off). ${deal.airline}, ${deal.stops === 0 ? 'nonstop' : deal.stops + ' stop'}. Book: ${deal.bookingUrl}`;

  try {
    await twilioClient.messages.create({
      body: msg.slice(0, 1600), // SMS character limit
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    return true;
  } catch (err) {
    logger.error(`SMS send failed: ${err.message}`);
    return false;
  }
}

// ─── BROWSER PUSH (WebSocket) ─────────────────────────────────────────────────

function pushToSocket(userId, payload) {
  const socket = socketsByUser.get(userId);
  if (socket) {
    socket.emit('notification', payload);
    return true;
  }
  return false;
}
