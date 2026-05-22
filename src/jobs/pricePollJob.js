// src/jobs/pricePollJob.js
//
// The autonomous background agent.
// Runs on a cron schedule, checks which alerts are due for a poll,
// calls the AI agent for each one, saves results, and fires notifications.
//
import cron from 'node-cron';
import { prisma } from '../utils/db.js';
import { runAgentForAlert, shouldNotify } from '../services/agentService.js';
import { sendDealNotification, sendPriceUpdateNotification } from '../services/notificationService.js';
import { logger } from '../utils/logger.js';

let isRunning = false; // prevent overlapping runs

/**
 * Process a single alert: call the AI agent, save price point, maybe notify.
 */
async function processAlert(alert) {
  logger.debug(`Processing alert ${alert.id}: ${alert.originCode}→${alert.destCode}`);

  try {
    const result = await runAgentForAlert(alert);
    if (!result || !result.bestPrice) {
      logger.warn(`No result for alert ${alert.id}`);
      return;
    }

    const newPrice = result.bestPrice;
    const bestDeal = result.deals?.[0];

    // Save price point to DB
    await prisma.pricePoint.create({
      data: {
        alertId: alert.id,
        price: newPrice,
        airline: bestDeal?.airline || null,
        source: 'ai_agent',
        dealScore: bestDeal?.dealScore || null,
        metadata: result,
      },
    });

    const oldPrice = alert.currentPrice;
    const isFirstCheck = !oldPrice;
    const basePrice = alert.basePrice || newPrice;

    // Determine if this is a deal
    const isDeal = shouldNotify(
      { ...alert, basePrice },
      newPrice
    );

    // Update alert in DB
    const newStatus = isDeal ? 'DEAL_FOUND' : 'WATCHING';
    await prisma.alert.update({
      where: { id: alert.id },
      data: {
        currentPrice: newPrice,
        basePrice: isFirstCheck ? newPrice : basePrice,
        lowestSeen: alert.lowestSeen
          ? Math.min(alert.lowestSeen, newPrice)
          : newPrice,
        status: newStatus,
        lastChecked: new Date(),
      },
    });

    logger.info(
      `📊 ${alert.originCode}→${alert.destCode}: $${newPrice} ` +
      `(was $${oldPrice || 'N/A'}) | status: ${newStatus}`
    );

    // Fire deal notification
    if (isDeal && bestDeal) {
      // Reload alert with user relation for notification
      const alertWithUser = await prisma.alert.findUnique({
        where: { id: alert.id },
        include: { user: true },
      });
      await sendDealNotification(alertWithUser, bestDeal, result);
    }
    // Fire minor price-change notification (browser only, no email)
    else if (!isFirstCheck && oldPrice && Math.abs(newPrice - oldPrice) > oldPrice * 0.03) {
      const alertWithUser = await prisma.alert.findUnique({
        where: { id: alert.id },
        include: { user: true },
      });
      await sendPriceUpdateNotification(alertWithUser, oldPrice, newPrice);
    }

  } catch (err) {
    logger.error(`Failed to process alert ${alert.id}: ${err.message}`);
  }
}

/**
 * Main polling function — finds all alerts due for a check and processes them.
 */
async function pollDueAlerts() {
  if (isRunning) {
    logger.debug('Poll already running, skipping this tick');
    return;
  }
  isRunning = true;

  try {
    const now = new Date();

    // Find all active alerts where it's time to check
    const dueAlerts = await prisma.alert.findMany({
      where: {
        status: { in: ['WATCHING', 'DEAL_FOUND'] },
        departDate: { gte: now }, // don't check past trips
        OR: [
          { lastChecked: null }, // never checked
          {
            lastChecked: {
              // checkFreq is in hours; compare against now
              lte: new Date(now.getTime() - 1000 * 60 * 60), // at least 1hr ago (we'll filter by freq below)
            },
          },
        ],
      },
      include: { user: true },
    });

    // Filter by each alert's own checkFreq setting
    const alertsToProcess = dueAlerts.filter(a => {
      if (!a.lastChecked) return true;
      const freqMs = a.checkFreq * 60 * 60 * 1000;
      return now - a.lastChecked >= freqMs;
    });

    if (alertsToProcess.length === 0) {
      logger.debug('No alerts due for polling');
      return;
    }

    logger.info(`🔍 Polling ${alertsToProcess.length} due alerts...`);

    // Process sequentially to avoid hammering the API
    for (const alert of alertsToProcess) {
      await processAlert(alert);
      // Small delay between alerts to be respectful to the API
      await new Promise(r => setTimeout(r, 2000));
    }

    logger.info(`✅ Poll complete. Processed ${alertsToProcess.length} alerts.`);

  } catch (err) {
    logger.error(`Poll job error: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the cron scheduler.
 * Default: every 30 minutes. Configurable via CRON_INTERVAL_MINUTES env var.
 */
export function startPollJob() {
  const intervalMin = parseInt(process.env.CRON_INTERVAL_MINUTES || '30');
  const cronExpr = `*/${intervalMin} * * * *`;

  logger.info(`⏰ Price poll job scheduled every ${intervalMin} minutes`);

  cron.schedule(cronExpr, () => {
    logger.info('⏰ Cron tick — running price poll');
    pollDueAlerts();
  });

  // Run immediately on startup so we don't wait for first tick
  logger.info('🚀 Running initial price poll on startup...');
  setTimeout(pollDueAlerts, 5000); // 5s delay to let server fully start
}

// Export for manual triggering via admin endpoint
export { pollDueAlerts };
