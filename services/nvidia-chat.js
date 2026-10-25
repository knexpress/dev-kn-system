const axios = require('axios');
const { buildKnexSystemPrompt } = require('./knex-system-prompt');

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);
const MAX_MESSAGES = 24;
const MAX_CONTENT = 4000;

function asText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('\n')
      .trim();
  }
  return '';
}

function stripThinking(text) {
  if (!text) return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|think\|>[\s\S]*?<\|\/think\|>/gi, '')
    .trim();
}

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-MAX_MESSAGES)
    .map((item) => {
      const role = ALLOWED_ROLES.has(item?.role) ? item.role : 'user';
      const content = asText(item?.content).slice(0, MAX_CONTENT);
      return content ? { role, content } : null;
    })
    .filter(Boolean)
    .filter((item) => item.role !== 'system');
}

function readSseReply(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let reply = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || json.choices?.[0]?.message?.content || '';
          if (delta) reply += delta;
        } catch {
          // ignore keep-alives
        }
      }
    });
    stream.on('end', () => resolve(stripThinking(reply)));
    stream.on('error', reject);
  });
}

async function invokeNvidia(payloadMessages) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    const error = new Error('NVIDIA_API_KEY is not configured');
    error.code = 'AI_NOT_CONFIGURED';
    throw error;
  }

  const invokeUrl =
    process.env.NVIDIA_API_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
  const model = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-bolt-e4b';
  const stream = true;

  const response = await axios.post(
    invokeUrl,
    {
      model,
      messages: payloadMessages,
      temperature: 1,
      top_p: 0.95,
      max_tokens: 1024,
      stream,
      parallel_tool_calls: true,
      chat_template_kwargs: { enable_thinking: true },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      responseType: 'stream',
      timeout: 60000,
    }
  );

  const reply = await readSseReply(response.data);
  if (!reply) {
    throw new Error('Empty model reply');
  }
  return { reply, model };
}

async function invokeLongcat(payloadMessages) {
  const apiKey = process.env.LONGCAT_API_KEY || process.env.NEXT_PUBLIC_LONGCAT_API_KEY;
  if (!apiKey) return null;

  const response = await axios.post(
    process.env.LONGCAT_API_URL || 'https://api.longcat.chat/openai/v1/chat/completions',
    {
      model: process.env.LONGCAT_MODEL || 'LongCat-2.5-Preview',
      messages: payloadMessages,
      max_tokens: 900,
      temperature: 0.7,
      stream: false,
      thinking: { type: 'disabled' },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 45000,
    }
  );

  const reply = stripThinking(asText(response.data?.choices?.[0]?.message?.content));
  if (!reply) throw new Error('Empty model reply');
  return { reply, model: response.data?.model || process.env.LONGCAT_MODEL };
}

function describeAiFailure(error) {
  if (!error) return 'the AI service did not respond.';
  if (error.code === 'AI_NOT_CONFIGURED') {
    return 'NVIDIA credentials are missing on the Finance backend.';
  }
  if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) {
    return 'NVIDIA chat timed out.';
  }
  if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
    return `the connection to NVIDIA failed (${error.code}).`;
  }

  const status = error.response?.status;
  const model = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-bolt-e4b';
  if (status === 401 || status === 403) return `NVIDIA rejected ${model} (HTTP ${status}).`;
  if (status === 404) return `NVIDIA model ${model} was not found (HTTP 404).`;
  if (status === 410) return `NVIDIA model ${model} is no longer available (HTTP 410).`;
  if (status === 429) return 'NVIDIA rate limit was hit (HTTP 429).';
  if (status === 402) return 'the AI provider reported insufficient quota (HTTP 402).';
  if (status) return `NVIDIA chat failed with HTTP ${status}.`;
  if (error.message === 'Empty model reply') return 'NVIDIA returned an empty reply.';
  return String(error.message || 'the AI service did not respond.').slice(0, 140);
}

function serviceDownReply(error) {
  return `KNEX Assistant is not working right now. Ask your IT Ali Abdullah to check: ${describeAiFailure(error)}`;
}

async function chatWithNvidia({ messages, firstName, department, role } = {}) {
  const history = sanitizeMessages(messages);
  if (!history.length) {
    const error = new Error('Message is required');
    error.code = 'EMPTY_MESSAGE';
    throw error;
  }

  const payloadMessages = [
    { role: 'system', content: buildKnexSystemPrompt({ firstName, department, role }) },
    ...history,
  ];

  try {
    return await invokeNvidia(payloadMessages);
  } catch (error) {
    if (error.code === 'AI_NOT_CONFIGURED') throw error;
    console.warn('[ai/chat] nvidia failed:', error.response?.status || error.message);
    try {
      const fallback = await invokeLongcat(payloadMessages);
      if (fallback) return fallback;
    } catch (fallbackError) {
      console.warn('[ai/chat] longcat failed:', fallbackError.response?.status || fallbackError.message);
    }
    throw error;
  }
}

module.exports = {
  chatWithNvidia,
  sanitizeMessages,
  describeAiFailure,
  serviceDownReply,
};
