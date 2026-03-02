/**
 * Kimi K2.5 API Client
 *
 * Provides a unified interface to interact with Moonshot AI's Kimi K2.5 model.
 * Uses OpenAI-compatible API for easy integration.
 *
 * API Documentation: https://platform.moonshot.ai/docs
 * Model: kimi-k2.5-preview
 * Base URL: https://api.moonshot.ai/v1
 */

const fs = require('fs');
const path = require('path');

// API Configuration
const KIMI_API_BASE = 'https://api.moonshot.ai/v1';
const KIMI_MODEL = 'kimi-k2.5-preview';

// Pricing per million tokens (input/output)
const PRICING = {
  input: 0.60,    // $0.60 per million input tokens
  output: 2.50,   // $2.50 per million output tokens
  cached: 0.15    // $0.15 per million cached tokens (75% savings)
};

// Context window limits
const CONTEXT_LIMITS = {
  maxTokens: 256000,  // 256K context window
  recommendedMax: 200000  // Recommended safe limit
};

/**
 * Load Kimi API key from API_KEYS.md or environment variable
 */
function getApiKey() {
  // Check environment variable first
  if (process.env.KIMI_API_KEY) {
    return process.env.KIMI_API_KEY;
  }

  // Try to read from API_KEYS.md
  try {
    const apiKeysPath = path.join(__dirname, '..', 'API_KEYS.md');
    if (fs.existsSync(apiKeysPath)) {
      const content = fs.readFileSync(apiKeysPath, 'utf-8');

      // Look for Kimi/Moonshot section
      const kimiMatch = content.match(/## (?:Kimi|Moonshot)[\s\S]*?API Key.*?`([^`]+)`/i);
      if (kimiMatch && kimiMatch[1] && kimiMatch[1] !== 'PENDING') {
        return kimiMatch[1];
      }
    }
  } catch (error) {
    console.error('Error reading API_KEYS.md:', error.message);
  }

  return null;
}

/**
 * Make a request to Kimi API
 *
 * @param {string} endpoint - API endpoint (e.g., '/chat/completions')
 * @param {Object} data - Request body
 * @param {Object} options - Request options
 * @returns {Promise<Object>} API response
 */
async function makeKimiRequest(endpoint, data, options = {}) {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error('Kimi API key not found. Set KIMI_API_KEY environment variable or add to API_KEYS.md');
  }

  const url = `${KIMI_API_BASE}${endpoint}`;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...options.headers
  };

  try {
    const response = await fetch(url, {
      method: options.method || 'POST',
      headers,
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Kimi API error (${response.status}): ${errorBody}`);
    }

    return await response.json();
  } catch (error) {
    // Check for rate limit
    if (error.message.includes('429') || error.message.includes('rate limit')) {
      throw new Error('Kimi API rate limit reached. Please wait and try again.');
    }
    throw error;
  }
}

/**
 * Chat completion with Kimi K2.5
 *
 * @param {Array} messages - Array of message objects [{role: 'user', content: '...'}]
 * @param {Object} options - Generation options
 * @returns {Promise<Object>} Completion result
 */
async function chatCompletion(messages, options = {}) {
  const requestData = {
    model: options.model || KIMI_MODEL,
    messages,
    temperature: options.temperature !== undefined ? options.temperature : 0.6,
    top_p: options.top_p !== undefined ? options.top_p : 0.95,
    max_tokens: options.max_tokens,
    stream: options.stream || false,
    tools: options.tools,
    tool_choice: options.tool_choice
  };

  // Remove undefined fields
  Object.keys(requestData).forEach(key => {
    if (requestData[key] === undefined) {
      delete requestData[key];
    }
  });

  const response = await makeKimiRequest('/chat/completions', requestData);

  return {
    content: response.choices[0].message.content,
    toolCalls: response.choices[0].message.tool_calls,
    usage: response.usage,
    cost: calculateCost(response.usage),
    model: response.model,
    finishReason: response.choices[0].finish_reason
  };
}

/**
 * Calculate cost based on token usage
 *
 * @param {Object} usage - Token usage from API response
 * @returns {Object} Cost breakdown
 */
function calculateCost(usage) {
  if (!usage) return { total: 0 };

  const inputCost = (usage.prompt_tokens / 1000000) * PRICING.input;
  const outputCost = (usage.completion_tokens / 1000000) * PRICING.output;
  const cachedCost = usage.cached_tokens ? (usage.cached_tokens / 1000000) * PRICING.cached : 0;

  return {
    input: inputCost.toFixed(6),
    output: outputCost.toFixed(6),
    cached: cachedCost.toFixed(6),
    total: (inputCost + outputCost + cachedCost).toFixed(6)
  };
}

/**
 * Streaming chat completion (for long responses)
 *
 * @param {Array} messages - Array of message objects
 * @param {Function} onChunk - Callback for each chunk
 * @param {Object} options - Generation options
 */
async function streamChatCompletion(messages, onChunk, options = {}) {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error('Kimi API key not found.');
  }

  const requestData = {
    model: options.model || KIMI_MODEL,
    messages,
    temperature: options.temperature !== undefined ? options.temperature : 0.6,
    top_p: options.top_p !== undefined ? options.top_p : 0.95,
    max_tokens: options.max_tokens,
    stream: true,
    tools: options.tools
  };

  Object.keys(requestData).forEach(key => {
    if (requestData[key] === undefined) {
      delete requestData[key];
    }
  });

  const url = `${KIMI_API_BASE}/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestData)
  });

  if (!response.ok) {
    throw new Error(`Kimi API error (${response.status}): ${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let fullContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const chunk = parsed.choices[0]?.delta?.content || '';
          if (chunk) {
            fullContent += chunk;
            await onChunk(chunk);
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }
  }

  return fullContent;
}

/**
 * Check if Kimi API is configured and available
 */
function isAvailable() {
  return getApiKey() !== null;
}

/**
 * Get pricing information
 */
function getPricing() {
  return { ...PRICING };
}

/**
 * Get context limits
 */
function getContextLimits() {
  return { ...CONTEXT_LIMITS };
}

/**
 * Simple chat helper (single user message)
 *
 * @param {string} prompt - User prompt
 * @param {Object} options - Generation options
 */
async function chat(prompt, options = {}) {
  return chatCompletion([
    { role: 'user', content: prompt }
  ], options);
}

/**
 * Multi-turn conversation helper
 *
 * @param {Array} conversationHistory - Array of messages
 * @param {string} newMessage - New user message
 * @param {Object} options - Generation options
 */
async function continueConversation(conversationHistory, newMessage, options = {}) {
  const messages = [
    ...conversationHistory,
    { role: 'user', content: newMessage }
  ];

  const result = await chatCompletion(messages, options);

  // Return updated conversation history
  return {
    result,
    history: [
      ...messages,
      { role: 'assistant', content: result.content }
    ]
  };
}

/**
 * Code generation helper (optimized for Kimi's strengths)
 *
 * @param {string} description - What to build
 * @param {Object} options - Generation options
 */
async function generateCode(description, options = {}) {
  const prompt = `Generate code for the following:

${description}

Please provide clean, well-commented code with explanations.`;

  return chat(prompt, {
    temperature: 0.6,  // Balanced for code generation
    ...options
  });
}

/**
 * Visual coding helper (one of Kimi's key strengths)
 *
 * @param {string} visualDescription - Description of UI/visual
 * @param {Object} options - Generation options
 */
async function generateFromVisual(visualDescription, options = {}) {
  const prompt = `Based on this visual description, generate the complete implementation:

${visualDescription}

Include HTML, CSS, and JavaScript as needed for a complete, interactive interface.`;

  return chat(prompt, {
    temperature: 0.6,
    max_tokens: 8000,  // Visual code can be lengthy
    ...options
  });
}

module.exports = {
  // Core API
  chatCompletion,
  streamChatCompletion,
  makeKimiRequest,

  // Helpers
  chat,
  continueConversation,
  generateCode,
  generateFromVisual,

  // Utilities
  isAvailable,
  getPricing,
  getContextLimits,
  calculateCost,
  getApiKey,

  // Constants
  KIMI_API_BASE,
  KIMI_MODEL,
  PRICING,
  CONTEXT_LIMITS
};
