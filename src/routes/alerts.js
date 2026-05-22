// src/routes/alerts.js
import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../utils/db.js';
import { requireAuth } from '../middleware/auth.js';
import { pollDueAlerts } from '../jobs/pricePollJob.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /api/alerts — list all user's alerts
router.get('/', async (req, res) => {
  const alerts = await prisma.alert.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    include: {
      priceHistory: {
        orderBy: { checkedAt: 'desc' },
        take: 30,
      },
      _count: { select: { notifications: true } },
    },
  });
  res.json(alerts);
});

// GET /api/alerts/:id — single alert with full history
router.get('/:id', async (req, res) => {
  const alert = await prisma.alert.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: {
      priceHistory: {
        orderBy: { checkedAt: 'asc' },
        take: 90,
      },
      notifications: {
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  });
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  res.json(alert);
});

// POST /api/alerts — create new alert
router.post('/',
  body('origin').notEmpty(),
  body('dest').notEmpty(),
  body('originCode').isLength({ min: 2, max: 4 }),
  body('destCode').isLength({ min: 2, max: 4 }),
  body('departDate').isISO8601(),
  body('maxBudget').isFloat({ min: 1 }),
  body('cabin').isIn(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']),
  validate,
  async (req, res) => {
    const {
      origin, dest, originCode, destCode,
      departDate, returnDate, cabin, passengers,
      maxBudget, targetDrop, checkFreq, channels,
    } = req.body;

    try {
      const alert = await prisma.alert.create({
        data: {
          userId: req.user.id,
          origin, dest,
          originCode: originCode.toUpperCase(),
          destCode: destCode.toUpperCase(),
          departDate: new Date(departDate),
          returnDate: returnDate ? new Date(returnDate) : null,
          cabin,
          passengers: passengers || 1,
          maxBudget: parseFloat(maxBudget),
          targetDrop: targetDrop || 10,
          checkFreq: checkFreq || 6,
          channels: Array.isArray(channels) ? channels.join(',') : (channels || 'email'),
          status: 'WATCHING',
        },
      });

      // Trigger immediate price check for new alert
      logger.info(`New alert created ${alert.id} — scheduling immediate check`);
      setTimeout(pollDueAlerts, 1000);

      res.status(201).json(alert);
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Failed to create alert' });
    }
  }
);

// PATCH /api/alerts/:id — update (pause, change settings)
router.patch('/:id', async (req, res) => {
  const { status, maxBudget, targetDrop, checkFreq, channels } = req.body;

  const alert = await prisma.alert.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!alert) return res.status(404).json({ error: 'Not found' });

  const updated = await prisma.alert.update({
    where: { id: req.params.id },
    data: {
      ...(status && { status }),
      ...(maxBudget && { maxBudget: parseFloat(maxBudget) }),
      ...(targetDrop && { targetDrop: parseInt(targetDrop) }),
      ...(checkFreq && { checkFreq: parseInt(checkFreq) }),
      ...(channels && { channels: Array.isArray(channels) ? channels.join(',') : channels }),
    },
  });
  res.json(updated);
});

// DELETE /api/alerts/:id
router.delete('/:id', async (req, res) => {
  const alert = await prisma.alert.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!alert) return res.status(404).json({ error: 'Not found' });

  await prisma.alert.delete({ where: { id: req.params.id } });
  res.json({ deleted: true });
});

// POST /api/alerts/:id/check-now — manually trigger an immediate poll
router.post('/:id/check-now', async (req, res) => {
  const alert = await prisma.alert.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: { user: true },
  });
  if (!alert) return res.status(404).json({ error: 'Not found' });

  // Run in background so HTTP response is instant
  const { runAgentForAlert, shouldNotify } = await import('../services/agentService.js');
  const { sendDealNotification } = await import('../services/notificationService.js');

  res.json({ message: 'Check triggered — results incoming via WebSocket' });

  try {
    const result = await runAgentForAlert(alert);
    if (!result) return;

    const newPrice = result.bestPrice;
    await prisma.alert.update({
      where: { id: alert.id },
      data: { currentPrice: newPrice, lastChecked: new Date() },
    });
    await prisma.pricePoint.create({
      data: { alertId: alert.id, price: newPrice, source: 'manual_check', metadata: result },
    });

    const { socketsByUser } = await import('../services/notificationService.js');
    const socket = socketsByUser.get(req.user.id);
    if (socket) socket.emit('check_result', { alertId: alert.id, result });

    if (shouldNotify(alert, newPrice) && result.deals?.[0]) {
      await sendDealNotification(alert, result.deals[0], result);
    }
  } catch (err) {
    logger.error(`Manual check failed: ${err.message}`);
  }
});

export default router;
