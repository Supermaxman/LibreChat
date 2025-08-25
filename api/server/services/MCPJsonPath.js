const { JSONPath } = require('jsonpath-plus');
const { logger } = require('@librechat/data-schemas');
const { getMessages } = require('~/models');
const { ContentTypes } = require('librechat-data-provider');

/**
 * @typedef {Object} REntry
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
    } catch (_) {}
  }
  return blocks;
}

/**
 * Safe JSON.parse for strings.
 * @param {string} s
 */
function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return v;
  } catch (_) {
    return null;
  }
}

/**
 * Only include:
 * 1) TOOL_CALL outputs: message.content has an entry with type=tool_call. We expect a "function.output" or similar string that contains JSON. Parse it; if that JSON contains a list of text parts, attempt second-level JSON parse of each .text as needed.
 * 2) Fenced ```json ... ``` blocks: parse their contents.
 * Everything else is ignored.
 *
 * Logs each inclusion and reasons for skips.
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

    let addedCount = 0;

    // 1) TOOL_CALL outputs
    if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        const toolCall = part && (part[ContentTypes.TOOL_CALL] || (part.type === ContentTypes.TOOL_CALL && part));
        if (!toolCall) {
          continue;
        }

        // Try common shapes for function output/body
        const functionOutput = toolCall?.function?.output;
        const bodyOutput = toolCall?.output; // fallback
        const outputString = typeof functionOutput === 'string' ? functionOutput : typeof bodyOutput === 'string' ? bodyOutput : null;
        if (!outputString) {
          logger.info(`[MCP-JSONPATH] TOOL_CALL found but output not string; msgIdx=${idx} id=${messageId}`);
          continue;
        }

        // First-level parse of the tool output
        const obj = tryParse(outputString);
        if (obj) {
          // if the tool output is a list of objects, we need to check if any of the objects have a type of "text"
          // if so, we need to parse the text as JSON
          // if not, we can add the object to the entries
          if (Array.isArray(obj)) {
            let foundParts = false;
            for (const item of obj) {
              if (item && typeof item === 'object' && !Array.isArray(item)) {
                if (item.type === "text") {
                  const inner = tryParse(item.text);
                  if (inner) {
                    entries.push({ json: inner, time, messageId, role });
                    addedCount++;
                    foundParts = true;
                    logger.info(
                      `[MCP-JSONPATH] ++ TOOL_CALL inner text JSON added: msgIdx=${idx} id=${messageId} keys=${Object.keys(inner).slice(0, 20).join(',')}`,
                    );
                  }
                }
              }
            }
            if (!foundParts) {
              entries.push({ json: obj, time, messageId, role });
              addedCount++;
              logger.info(
                `[MCP-JSONPATH] ++ TOOL_CALL object LIST JSON added: msgIdx=${idx} id=${messageId} keys=${Object.keys(obj).slice(0, 20).join(',')}`,
              );
            }
          } else {
            entries.push({ json: obj, time, messageId, role });
            addedCount++;
            logger.info(
              `[MCP-JSONPATH] ++ TOOL_CALL object JSON added: msgIdx=${idx} id=${messageId} keys=${Object.keys(obj).slice(0, 20).join(',')}`,
            );
          }
        }
      }
    }


    // 2) Fenced json blocks in message.text
    if (typeof msg?.text === 'string' && msg.text) {
      const blocks = extractJsonCodeBlocks(msg.text);
      for (let b = 0; b < blocks.length; b++) {
        const obj = blocks[b];
        entries.push({ json: obj, time, messageId, role });
        addedCount++;
        logger.info(
          `[MCP-JSONPATH] + CODEBLOCK message.text JSON added: msgIdx=${idx} id=${messageId} #${b} keys=${Object.keys(obj).slice(0, 20).join(',')}`,
        );
      }
    }

    // 2b) Fenced json blocks in any content text parts
    if (Array.isArray(msg?.content)) {
      for (let p = 0; p < msg.content.length; p++) {
        const part = msg.content[p];
        if (!part || part.type !== 'text' || typeof part.text !== 'string') {
          continue;
        }
        const blocks = extractJsonCodeBlocks(part.text);
        for (let b = 0; b < blocks.length; b++) {
          const obj = blocks[b];
          entries.push({ json: obj, time, messageId, role });
          addedCount++;
          logger.info(
            `[MCP-JSONPATH] + CODEBLOCK content text JSON added: msgIdx=${idx} id=${messageId} part=${p} #${b} keys=${Object.keys(obj).slice(0, 20).join(',')}`,
          );
        }
      }
    }

    if (addedCount === 0) {
      logger.info(`[MCP-JSONPATH] - Skipped message idx=${idx} id=${messageId} role=${role} (no explicit JSON sources)`);
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
    logger.info(
      `[MCP-JSONPATH] Loaded history (persistent only) for thread=${conversationId} | jsonEntries=${persistentEntries.length}`,
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
 * Build the JSONPath root array from REntry[] by selecting only valid JSON objects.
 * @param {REntry[]} entries
 * @returns {Array<object>} jsonRoot
 */
function buildJsonRoot(entries) {
  const arr = Array.isArray(entries) ? entries : [];
  logger.info(`[MCP-JSONPATH] Built JSON root array with length=${arr.length}`);
  try {
    logger.info(`[MCP-JSONPATH] Context JSON dump: ${JSON.stringify(arr)}`);
  } catch (_) {}
  return arr;
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
 * - Single-whole-string placeholder preserves type (native substitution). This allows numbers/objects/arrays/booleans/null to be inserted without quotes.
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
      logger.info(`[MCP-JSONPATH] Evaluated placeholder (single/native) expr="${expr}" -> type=${typeof result}\n${JSON.stringify(result)}`);
      return result;
    }

    input = input.replace(placeholderRegex, (_, rawExpr) => {
      const expr = normalizeExpr(rawExpr);
      const result = safeEval(expr, jsonRoot);
      logger.info(`[MCP-JSONPATH] Evaluated placeholder expr="${expr}" -> type=${typeof result}\n${JSON.stringify(result)}`);
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

function normalizeExpr(expr) {
  const stripped = String(expr).trim();
  if (!stripped.startsWith('$')) {
    if (stripped.startsWith('[')) {
      return `$${stripped}`;
    }
    return `$${stripped}`;
  }
  return stripped;
}

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



