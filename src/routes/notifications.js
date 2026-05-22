// src/routes/notifications.js
import { Router } from 'express';
import { prisma } from '../utils/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/notifications
router.get('/', async (req, res) => {
  const { unread, limit = 50 } = req.query;
  const notifications = await prisma.notification.findMany({
    where: {
      userId: req.user.id,
      ...(unread === 'true' && { read: false }),
    },
    orderBy: { createdAt: 'desc' },
    take: parseInt(limit),
    include: { alert: { select: { originCode: true, destCode: true, cabin: true } } },
  });
  res.json(notifications);
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', async (req, res) => {
  await prisma.notification.updateMany({
    where: { id: req.params.id, userId: req.user.id },
    data: { read: true },
  });
  res.json({ ok: true });
});

// PATCH /api/notifications/read-all
router.patch('/read-all', async (req, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.user.id, read: false },
    data: { read: true },
  });
  res.json({ ok: true });
});

export default router;
