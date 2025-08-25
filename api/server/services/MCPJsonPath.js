const { JSONPath } = require('jsonpath-plus');
const { logger } = require('@librechat/data-schemas');
const { getMessages } = require('~/models');

/**
 * @typedef {Object} REntry
 * @property {string} [name]
 * @property {string} [server]
 * @property {unknown} [args]
 * @property {string} [text]
 * @property {unknown} [artifact]
 * @property {Record<string, unknown>} [json]
 * @property {number} [time]
 * @property {string} [messageId]
 * @property {string} [role]
 */

/**
 * Extract JSON objects from fenced code blocks within a string.
 * Matches ```json ... ``` (case-insensitive) and returns successfully parsed objects in order.
 * @param {string} s
 * @returns {Record<string, unknown>[]} parsed blocks
 */
function extractJsonCodeBlocks(s) {
  if (typeof s !== 'string' || !s) {
    return [];
  }
  const blocks = [];
  const re = /```\s*json\s*([\s\S]*?)\s*```/gi;
  let match;
  while ((match = re.exec(s)) !== null) {
    const payload = match[1];
    try {
      const obj = JSON.parse(payload);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        blocks.push(obj);
      }
    } catch (_) {
      // ignore invalid block
    }
  }
  return blocks;
}

/**
 * Build entries from persisted conversation messages.
 * Extracts text and attempts to parse JSON for later JSONPath queries.
 * Also includes explicit ```json ... ``` fenced blocks from user/assistant messages.
 * Preserves message order and code-block order.
 * @param {Array} messages
 * @returns {REntry[]}
 */
function buildEntriesFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  const entries = [];
  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    const time = new Date(msg.createdAt || Date.now()).getTime();
    const messageId = msg.messageId;
    const role = msg.sender;

    let included = false;
    let parsedTextJson = false;
    let codeBlockCount = 0;

    // 1) Whole-message or aggregated text JSON
    let text = '';
    if (typeof msg?.text === 'string' && msg.text.trim()) {
      text = msg.text;
    } else if (Array.isArray(msg?.content) && msg.content.length) {
      const parts = msg.content.filter((p) => p && p.type === 'text').map((p) => p.text);
      if (parts.length) {
        text = parts.join('\n\n');
      }
    }
    if (text) {
      const parsed = tryParseJson(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entries.push({ text, json: parsed, time, messageId, role });
        included = true;
        parsedTextJson = true;
        try {
          logger.info(
            `[MCP-JSONPATH] + Persisted message idx=${idx} id=${messageId} role=${role} -> added text JSON with keys=${Object.keys(parsed).slice(0, 20).join(',')}`,
          );
        } catch (_) {}
      }
    }

    // 2) Explicit JSON code blocks from message.text
    if (typeof msg?.text === 'string' && msg.text) {
      const blocks = extractJsonCodeBlocks(msg.text);
      codeBlockCount += blocks.length;
      for (let b = 0; b < blocks.length; b++) {
        const obj = blocks[b];
        entries.push({ text: '```json\n...\n```', json: obj, time, messageId, role });
        included = true;
        try {
          logger.info(
            `[MCP-JSONPATH] + Persisted message idx=${idx} id=${messageId} role=${role} -> added code-block JSON #${b} keys=${Object.keys(obj).slice(0, 20).join(',')}`,
          );
        } catch (_) {}
      }
    }

    // 3) Explicit JSON code blocks from each content text part (in order)
    if (Array.isArray(msg?.content) && msg.content.length) {
      for (let p = 0; p < msg.content.length; p++) {
        const part = msg.content[p];
        if (!part || part.type !== 'text' || typeof part.text !== 'string') {
          continue;
        }
        const blocks = extractJsonCodeBlocks(part.text);
        codeBlockCount += blocks.length;
        for (let b = 0; b < blocks.length; b++) {
          const obj = blocks[b];
          entries.push({ text: '```json\n...\n```', json: obj, time, messageId, role });
          included = true;
          try {
            logger.info(
              `[MCP-JSONPATH] + Persisted message idx=${idx} id=${messageId} role=${role} -> added content-block JSON part=${p} #${b} keys=${Object.keys(obj).slice(0, 20).join(',')}`,
            );
          } catch (_) {}
        }
      }
    }

    if (!included) {
      logger.info(
        `[MCP-JSONPATH] - Skipped message idx=${idx} id=${messageId} role=${role} (no valid JSON found; codeBlocks=${codeBlockCount}, parsedText=${parsedTextJson})`,
      );
    }
  }
  return entries;
}

/**
 * Load prior tool call results from persistent storage only (no cache merge), preserving order.
 * @param {string} conversationId
 * @returns {Promise<REntry[]>}
 */
async function loadHistory(conversationId) {
  try {
    const persistedMessages = (await getMessages({ conversationId })) || [];
    const persistentEntries = buildEntriesFromMessages(persistedMessages);
    const jsonCount = persistentEntries.filter((e) => e && e.json && typeof e.json === 'object' && !Array.isArray(e.json)).length;
    logger.info(
      `[MCP-JSONPATH] Loaded history (persistent only) for thread=${conversationId} | jsonEntries=${jsonCount}, total=${persistentEntries.length}`,
    );
    return persistentEntries;
  } catch (err) {
    logger.warn(
      `[MCP-JSONPATH] Failed to load persistent history for thread=${conversationId}: ${err?.message}`,
    );
    return [];
  }
}

/**
 * Best-effort JSON parse helper for message/tool text.
 * @param {string} text
 * @returns {unknown|null}
 */
function tryParseJson(text) {
  if (typeof text !== 'string' || !text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (_) {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const candidate = text.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * Build the JSONPath root array from REntry[] by selecting only valid JSON objects.
 * @param {REntry[]} entries
 * @returns {Array<object>} jsonRoot
 */
function buildJsonRoot(entries) {
  const arr = Array.isArray(entries) ? entries : [];
  const jsons = arr
    .map((e) => (e && e.json && typeof e.json === 'object' && !Array.isArray(e.json) ? e.json : null))
    .filter(Boolean);
  logger.info(`[MCP-JSONPATH] Built JSON root array with length=${jsons.length}`);
  try {
    logger.info(`[MCP-JSONPATH] Context JSON dump: ${JSON.stringify(jsons)}`);
  } catch (_) {}
  return jsons;
}

/**
 * Public API: Evaluate placeholders by building jsonRoot once, then delegating.
 * @param {unknown} value
 * @param {{ r: REntry[] }} context
 * @returns {unknown}
 */
function evaluatePlaceholders(value, context) {
  const jsonRoot = buildJsonRoot(context?.r);
  return evaluatePlaceholdersWithRoot(value, jsonRoot);
}

/**
 * Internal helper: Evaluate placeholders ${{ ... }} with a precomputed jsonRoot.
 * - Single-whole-string placeholder preserves type.
 * - Mixed text interpolates with stringified non-strings.
 * - Escapes: \${{ -> literal ${ {, \$ -> literal $.
 * @param {unknown} value
 * @param {Array<object>} jsonRoot
 * @returns {unknown}
 */
function evaluatePlaceholdersWithRoot(value, jsonRoot) {
  if (value == null) {
    return value;
  }

  if (typeof value === 'string') {
    const ESC_DOLLAR_OPEN = '__ESC_DOLLAR_OPEN__';
    const ESC_DOLLAR = '__ESC_DOLLAR__';
    let input = value.replace(/\\\$\{\{/g, ESC_DOLLAR_OPEN).replace(/\\\$/g, ESC_DOLLAR);

    const placeholderRegex = /\$\{\{([\s\S]+?)\}\}/g;
    const onlyOne = input.trim().match(/^\$\{\{([\s\S]+?)\}\}$/);
    if (onlyOne) {
      const expr = normalizeExpr(onlyOne[1]);
      const result = safeEval(expr, jsonRoot);
      logger.info(`[MCP-JSONPATH] Evaluated placeholder (single) expr="${expr}" -> type=${typeof result}`);
      return result;
    }

    input = input.replace(placeholderRegex, (_, rawExpr) => {
      const expr = normalizeExpr(rawExpr);
      const result = safeEval(expr, jsonRoot);
      logger.info(`[MCP-JSONPATH] Evaluated placeholder expr="${expr}" -> type=${typeof result}`);
      if (result == null) {
        return '';
      }
      if (typeof result === 'string') {
        return result;
      }
      try {
        return JSON.stringify(result);
      } catch (_) {
        return String(result);
      }
    });

    return input.replace(new RegExp(ESC_DOLLAR_OPEN, 'g'), '${{').replace(new RegExp(ESC_DOLLAR, 'g'), '$');
  }
  if (Array.isArray(value)) {
    return value.map((v) => evaluatePlaceholdersWithRoot(v, jsonRoot));
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [k, v] of Object.entries(value)) {
      output[k] = evaluatePlaceholdersWithRoot(v, jsonRoot);
    }
    return output;
  }
  return value;
}

/**
 * Normalize expressions so bare identifiers become JSONPath rooted to `$` (array).
 * Accepts:
 *   $[-1].id
 *   [-1].id   (will be normalized to $[-1].id)
 * @param {string} expr
 */
function normalizeExpr(expr) {
  const stripped = String(expr).trim();
  if (!stripped.startsWith('$')) {
    if (stripped.startsWith('[')) {
      return `$${stripped}`;
    }
    // default to array-root without dot
    return `$${stripped}`;
  }
  return stripped;
}

/**
 * Safely evaluate JSONPath against an array root. Unwrap singleton arrays.
 * @param {string} jsonPath
 * @param {Array<object>} jsonRoot
 */
function safeEval(jsonPath, jsonRoot) {
  try {
    const res = JSONPath({ path: jsonPath, json: jsonRoot, wrap: true });
    if (!Array.isArray(res)) {
      return res;
    }
    return res.length === 1 ? res[0] : res;
  } catch (err) {
    logger.warn(`[MCP-JSONPATH] JSONPath eval failed for expr="${jsonPath}": ${err?.message}`);
    return undefined;
  }
}

module.exports = {
  loadHistory,
  evaluatePlaceholders,
};



