// src/index.js  — SkyScout Backend Server
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { rateLimit } from 'express-rate-limit';
import jwt from 'jsonwebtoken';

import { logger }          from './utils/logger.js';
import { prisma }          from './utils/db.js';
import { socketsByUser }   from './services/notificationService.js';
import { startPollJob }    from './jobs/pricePollJob.js';

import authRoutes          from './routes/auth.js';
import alertRoutes         from './routes/alerts.js';
import notifRoutes         from './routes/notifications.js';

// ─── APP SETUP ───────────────────────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);

// Socket.IO for real-time browser notifications
const io = new SocketServer(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
  },
});

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.use('/api/auth',          authRoutes);
app.use('/api/alerts',        alertRoutes);
app.use('/api/notifications', notifRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// Admin: manually trigger poll (protect this in production!)
app.post('/admin/poll-now', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.JWT_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { pollDueAlerts } = await import('./jobs/pricePollJob.js');
  pollDueAlerts(); // fire and forget
  res.json({ message: 'Poll triggered' });
});

// ─── SOCKET.IO — REAL-TIME BROWSER PUSH ──────────────────────────────────────

io.on('connection', (socket) => {
  logger.debug(`Socket connected: ${socket.id}`);

  // Client must authenticate immediately after connecting
  socket.on('authenticate', (token) => {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socketsByUser.set(payload.userId, socket);
      socket.userId = payload.userId;
      socket.emit('authenticated', { userId: payload.userId });
      logger.debug(`Socket authenticated for user ${payload.userId}`);
    } catch {
      socket.emit('auth_error', { error: 'Invalid token' });
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      socketsByUser.delete(socket.userId);
      logger.debug(`Socket disconnected: ${socket.userId}`);
    }
  });
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, async () => {
  logger.info(`🚀 SkyScout backend running on http://localhost:${PORT}`);
  logger.info(`🗄  Database: ${process.env.DATABASE_URL?.split('@')[1]?.split('/')[0] || 'connected'}`);

  // Verify DB connection
  try {
    await prisma.$connect();
    logger.info('✅ Database connected');
  } catch (err) {
    logger.error(`❌ Database connection failed: ${err.message}`);
    process.exit(1);
  }

  // Start the autonomous price polling agent
  startPollJob();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  await prisma.$disconnect();
  process.exit(0);
});
