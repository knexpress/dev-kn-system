/**
 * Motivational quotes via NVIDIA Integrate chat completions.
 * Falls back to a local quote bank if the API key is missing or the call fails.
 */

const axios = require('axios');

const QUOTE_WINDOW_MS = 10 * 60 * 1000;

const FALLBACK_QUOTES = [
  'Progress is built one careful shipment, one clear invoice, one honest decision at a time.',
  'Stay sharp, stay kind, and let excellence be your quiet routine.',
  'The best teams move with purpose — clarity today creates calm tomorrow.',
  'Small wins compound. Finish this hour better than you started it.',
  'Own the details. Trust follows people who make the hard things look simple.',
  'Your focus is a competitive advantage — protect it and use it well.',
  'Consistency beats intensity. Show up again, even when the day feels heavy.',
  'Lead with solutions. Every obstacle is a chance to raise the standard.',
  'Accuracy is respect — for clients, for teammates, and for yourself.',
  'Energy follows intention. Choose the next right action and take it.',
  'You do not need a perfect day. You need a committed one.',
  'Logistics runs on trust. Be the person others can count on.',
];

/** @type {Map<string, { quote: string; source: string; expiresAt: number }>} */
const cache = new Map();

function currentWindowKey(extra = '') {
  const bucket = Math.floor(Date.now() / QUOTE_WINDOW_MS);
  return `${bucket}:${extra}`;
}

function pickFallback(seed = Date.now()) {
  const index = Math.abs(seed) % FALLBACK_QUOTES.length;
  return {
    quote: FALLBACK_QUOTES[index],
    source: 'fallback',
    windowMs: QUOTE_WINDOW_MS,
    expiresAt: (Math.floor(Date.now() / QUOTE_WINDOW_MS) + 1) * QUOTE_WINDOW_MS,
  };
}

function cleanQuote(text) {
  if (!text || typeof text !== 'string') return null;
  let cleaned = text
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/^Quote:\s*/i, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0];
  if (!cleaned) return null;
  if (cleaned.length > 220) cleaned = `${cleaned.slice(0, 217).trim()}…`;
  return cleaned;
}

async function fetchQuoteFromNvidia({ firstName, department } = {}) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    return null;
  }

  const invokeUrl =
    process.env.NVIDIA_API_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
  const model = process.env.NVIDIA_MODEL || 'moonshotai/kimi-k3';

  const name = firstName || 'teammate';
  const dept = department || 'operations';

  const payload = {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `Write one original motivational quote (maximum 22 words) for ${name} ` +
              `on a logistics and finance operations team (${dept}). ` +
              'Return ONLY the quote sentence. No quotation marks, no author, no preamble.',
          },
        ],
      },
    ],
    model,
    max_tokens: 120,
    temperature: 0.95,
    stream: false,
  };

  const response = await axios.post(invokeUrl, payload, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    timeout: 25000,
  });

  const content = response.data?.choices?.[0]?.message?.content;
  return cleanQuote(typeof content === 'string' ? content : content?.[0]?.text);
}

/**
 * Returns a motivational quote for the current 10-minute window.
 * Cached per user so reloads in the same window reuse the same quote.
 */
async function getMotivationalQuote({ userId, firstName, department } = {}) {
  const key = currentWindowKey(userId || 'anon');
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      quote: cached.quote,
      source: cached.source,
      windowMs: QUOTE_WINDOW_MS,
      expiresAt: cached.expiresAt,
      cached: true,
    };
  }

  const expiresAt = (Math.floor(Date.now() / QUOTE_WINDOW_MS) + 1) * QUOTE_WINDOW_MS;

  try {
    const generated = await fetchQuoteFromNvidia({ firstName, department });
    if (generated) {
      const entry = { quote: generated, source: 'nvidia', expiresAt };
      cache.set(key, entry);
      return { ...entry, windowMs: QUOTE_WINDOW_MS, cached: false };
    }
  } catch (error) {
    console.warn(
      '[nvidia-motivation] API call failed, using fallback:',
      error.response?.status || error.message
    );
  }

  const fallback = pickFallback(
    `${userId || ''}:${Math.floor(Date.now() / QUOTE_WINDOW_MS)}`.split('').reduce(
      (acc, ch) => acc + ch.charCodeAt(0),
      0
    )
  );
  cache.set(key, { quote: fallback.quote, source: fallback.source, expiresAt: fallback.expiresAt });
  return { ...fallback, cached: false };
}

module.exports = {
  getMotivationalQuote,
  QUOTE_WINDOW_MS,
};
