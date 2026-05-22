// src/services/agentService.js
//
// The SkyScout AI agent: given an alert, uses Claude + web_search
// to find the best current flight deals and score them.
//
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Airline booking URLs by cabin class
const AIRLINE_URLS = {
  economy: {
    'Norse Atlantic': 'https://www.flynorse.com',
    'Icelandair':     'https://www.icelandair.com',
    'JetBlue':        'https://www.jetblue.com',
    'Norwegian':      'https://www.norwegian.com',
    'Condor':         'https://www.condor.com',
    'Ryanair':        'https://www.ryanair.com',
    'EasyJet':        'https://www.easyjet.com',
    'WestJet':        'https://www.westjet.com',
    'Spirit':         'https://www.spirit.com',
    'Frontier':       'https://www.flyfrontier.com',
  },
  business: {
    'British Airways':  'https://www.britishairways.com',
    'Virgin Atlantic':  'https://www.virginatlantic.com',
    'Air France':       'https://www.airfrance.com',
    'Lufthansa':        'https://www.lufthansa.com',
    'Emirates':         'https://www.emirates.com',
    'Qatar Airways':    'https://www.qatarairways.com',
    'Singapore Airlines':'https://www.singaporeair.com',
    'Cathay Pacific':   'https://www.cathaypacific.com',
    'Turkish Airlines': 'https://www.turkishairlines.com',
    'Delta':            'https://www.delta.com',
  },
  first: {
    'Singapore Airlines':'https://www.singaporeair.com',
    'Emirates':          'https://www.emirates.com',
    'Cathay Pacific':    'https://www.cathaypacific.com',
    'ANA':               'https://www.ana.co.jp/en/us/',
    'Qatar Airways':     'https://www.qatarairways.com',
    'Lufthansa':         'https://www.lufthansa.com',
    'Swiss':             'https://www.swiss.com',
    'JAL':               'https://www.jal.com',
  },
};

const AGGREGATOR_URLS = [
  { name: 'Google Flights', url: 'https://www.google.com/travel/flights' },
  { name: 'Skyscanner',     url: 'https://www.skyscanner.com' },
  { name: 'Kayak',          url: 'https://www.kayak.com' },
  { name: 'Momondo',        url: 'https://www.momondo.com' },
  { name: 'Expedia',        url: 'https://www.expedia.com' },
  { name: 'Hopper',         url: 'https://www.hopper.com' },
];

/**
 * Run the AI agent for a single alert.
 * Returns an array of deal objects with prices, airlines, booking links, etc.
 *
 * @param {object} alert - Prisma Alert record
 * @returns {Promise<AgentResult>}
 */
export async function runAgentForAlert(alert) {
  const cabinKey = alert.cabin.toLowerCase().replace('_', ' ');
  const airlineUrls = AIRLINE_URLS[cabinKey.split(' ')[0]] || AIRLINE_URLS.economy;

  const systemPrompt = `You are SkyScout, an expert autonomous flight price monitoring agent.
Your job: search for the current best flight deals and return structured JSON only.
Always search for real, current prices. Be accurate and honest about pricing.
Return ONLY valid JSON — no markdown, no prose, no backticks.`;

  const userPrompt = `Find the best current flight deals for this alert:

ROUTE: ${alert.origin} → ${alert.dest}
CABIN: ${cabinKey}
DEPART: ${alert.departDate.toISOString().slice(0, 10)}
RETURN: ${alert.returnDate ? alert.returnDate.toISOString().slice(0, 10) : 'one-way'}
PASSENGERS: ${alert.passengers}
MAX BUDGET: $${alert.maxBudget} per person

Search across these airlines and aggregators:
Airlines: ${Object.keys(airlineUrls).join(', ')}
Aggregators: ${AGGREGATOR_URLS.map(a => a.name).join(', ')}

Return this exact JSON structure:
{
  "searchedAt": "ISO timestamp",
  "route": "${alert.originCode}-${alert.destCode}",
  "bestPrice": <number — lowest price found in USD>,
  "averagePrice": <number — typical price for this route/season>,
  "currency": "USD",
  "deals": [
    {
      "rank": 1,
      "airline": "airline name",
      "price": <number>,
      "normalPrice": <number — what this ticket usually costs>,
      "savingsPct": <number — percentage saved vs normal>,
      "stops": <number — 0 for nonstop>,
      "durationMinutes": <number — total travel time>,
      "bookingUrl": "direct airline or aggregator URL",
      "bookingPlatform": "platform name",
      "dealScore": <0-100 — how good is this deal>,
      "reason": "1 sentence why this is a good deal"
    }
  ],
  "timing": {
    "buyNow": <true/false>,
    "buyNowReason": "brief explanation",
    "bestDayToBook": "day of week",
    "bestTimeToBook": "time window",
    "flexTip": "one flex date suggestion to save more",
    "priceOutlook": "rising|falling|stable"
  },
  "seasonalNote": "brief note about pricing for this route/season"
}

Return exactly 3-5 deals, sorted cheapest first. Use real current prices from your web search.`;

  try {
    logger.info(`🤖 Agent searching: ${alert.originCode} → ${alert.destCode} (${cabinKey})`);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Extract text content from response (may include tool_use blocks)
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) {
      throw new Error('No text response from agent');
    }

    // Parse JSON — strip any accidental markdown fences
    const raw = textBlock.text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(raw);

    logger.info(`✅ Agent found ${result.deals?.length || 0} deals. Best: $${result.bestPrice}`);
    return result;

  } catch (err) {
    logger.error(`Agent error for alert ${alert.id}: ${err.message}`);
    // Return a fallback so the cron job doesn't crash
    return null;
  }
}

/**
 * Calculate a deal score comparing current price vs base price.
 * Used to decide whether to fire a notification.
 */
export function shouldNotify(alert, newPrice) {
  if (!alert.basePrice || !newPrice) return false;
  const dropPct = ((alert.basePrice - newPrice) / alert.basePrice) * 100;
  return dropPct >= alert.targetDrop;
}
