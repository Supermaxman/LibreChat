const express = require('express');
const crypto = require('crypto');
const PQueue = require('p-queue').default;
const { logger } = require('@librechat/data-schemas');
const {
  EModelEndpoint,
  Constants,
  extractEnvVariable,
} = require('librechat-data-provider');
const { getCustomConfig } = require('~/server/services/Config');
const { loadAgent } = require('~/models/Agent');
const { findUser } = require('~/models');
const AgentController = require('~/server/controllers/agents/request');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const addTitle = require('~/server/services/Endpoints/agents/title');
const { Writable } = require('stream');
const { z } = require('zod');

const webhookResponseSchema = z.object({
  reqResponseCode: z.number(),
  reqResponseContent: z.string(),
  reqResponseContentType: z.string().optional(),
  promptContent: z.string().optional(),
});


const router = express.Router();
const queue = new PQueue({ concurrency: 1 });


function resolveEnvValue(value, name, keyPath) {
  if (typeof value !== 'string') {
    return value;
  }
  const resolved = extractEnvVariable(value);
  return resolved;
}


async function processMCPWebhook({ req, name, userId, hookConfig, promptContent }) {
  try {
    const prefix = hookConfig.prompt ? `${hookConfig.prompt}\n\n` : '';
    const text = `${prefix}${promptContent ?? ''}`;

    const agentReq = req;
    agentReq.user = { id: userId };
    agentReq.body = {
      text,
      endpoint: EModelEndpoint.agents,
      agent_id: hookConfig.agent_id,
      parentMessageId: Constants.NO_PARENT,
      endpointOption: {
        endpoint: EModelEndpoint.agents,
        agent_id: hookConfig.agent_id,
        agent: loadAgent({
          req: { user: { id: userId } },
          agent_id: hookConfig.agent_id,
          endpoint: EModelEndpoint.agents,
        }),
        model_parameters: {},
      },
    };

    const dummyRes = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    dummyRes.write = () => {};
    dummyRes.end = () => {};
    dummyRes.setHeader = () => {};
    dummyRes.status = () => dummyRes;
    dummyRes.json = () => {};
    dummyRes.on = () => {};
    dummyRes.removeListener = () => {};

    await AgentController(agentReq, dummyRes, () => {}, initializeClient, addTitle);
    logger.info(`[mcp-webhook:${name}] Processed prompt for user ${userId}`);
  } catch (error) {
    logger.error(`[mcp-webhook:${name}] processing failed`, error);
  }
}

function buildTargetWebhookUrl({ baseUrl, hook, query }) {
  const urlObj = new URL(baseUrl);
  // remove trailing /mcp if present
  urlObj.pathname = urlObj.pathname.replace(/\/?mcp\/?$/i, '/');
  // ensure no trailing slash before appending
  const basePath = urlObj.pathname.replace(/\/$/, '');
  const target = new URL(`${urlObj.origin}${basePath}/webhooks/${encodeURIComponent(hook)}`);
  // append query params from incoming request
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        v.forEach((vv) => target.searchParams.append(k, String(vv)));
      } else {
        target.searchParams.set(k, String(v));
      }
    }
  }
  return target.toString();
}

function prepareProxyHeaders(incomingHeaders, extraHeaders) {
  const out = { ...incomingHeaders };
  // override/merge with configured headers last
  Object.assign(out, extraHeaders || {});
  // remove hop-by-hop headers and ones we will let undici/node compute
  delete out['host'];
  delete out['content-length'];
  delete out['connection'];
  delete out['accept-encoding'];
  return out;
}

function resolveEnvValue(value) {
  if (typeof value !== 'string') return value;
  return extractEnvVariable(value);
}

function resolveHookConfigDeep(input) {
  if (input == null) return input;
  if (typeof input === 'string') return resolveEnvValue(input);
  if (Array.isArray(input)) return input.map((v) => resolveHookConfigDeep(v));
  if (typeof input === 'object') {
    const out = Array.isArray(input) ? [] : {};
    for (const k of Object.keys(input)) {
      out[k] = resolveHookConfigDeep(input[k]);
    }
    return out;
  }
  return input;
}

// Dynamic MCP webhook proxy: /api/webhooks/:server/:hook
router.all('/:server/:hook', async (req, res, next) => {
  const { server, hook } = req.params;
  const config = await getCustomConfig();
  const mcpServers = config?.mcpServers || {};
  const serverConfig = mcpServers?.[server];

  // only servers with URL-based transports are supported
  const hasUrl = typeof serverConfig?.url === 'string' && serverConfig.url.length > 0;
  const hookConfigRaw = serverConfig?.webhooks?.[hook];

  if (!serverConfig || !hasUrl || !hookConfigRaw) {
    return next(); // fall through to other routes like legacy /:name handler
  }

  const hookConfig = resolveHookConfigDeep(hookConfigRaw);

  try {
    const targetUrl = buildTargetWebhookUrl({ baseUrl: serverConfig.url, hook, query: req.query });

    // Build request init
    const method = req.method.toUpperCase();
    const headers = prepareProxyHeaders(req.headers, serverConfig.headers);

    let body;
    if (method !== 'GET' && method !== 'HEAD') {
      if (req.rawBody) {
        body = req.rawBody;
      } else if (req.is('application/json')) {
        body = JSON.stringify(req.body ?? {});
        headers['content-type'] = headers['content-type'] || 'application/json';
      } else if (typeof req.body === 'string') {
        body = req.body;
      } else {
        // Fallback serialize for unknown types
        body = JSON.stringify(req.body ?? {});
        headers['content-type'] = headers['content-type'] || 'application/json';
      }
    }

    const controller = new AbortController();
    const timeoutMs = serverConfig.timeout ?? serverConfig.initTimeout ?? 30000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(targetUrl, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    // If upstream is non-200, pass it through unchanged (such as 401, 403, 404, etc.)
    if (response.status !== 200) {
      const upstreamContentType = response.headers.get('content-type') || 'text/plain';
      const upstreamText = await response.text().catch(() => '');
      res.set('Content-Type', upstreamContentType);
      return res.status(response.status).send(upstreamText);
    }

    const data = await response.json();
    const parsed = webhookResponseSchema.safeParse(data);

    // Prepare planned response (send after queueing)
    const responseCode = parsed.data.reqResponseCode;
    const responseContentType = parsed.data.reqResponseContentType === 'json' ? 'application/json' : 'text/plain';
    const responseContent = parsed.data.reqResponseContent;
    const promptContent = parsed.data.promptContent;
    // Enqueue prompt processing if present
    if (promptContent) {
      const user = await findUser({ email: hookConfig.user });
      const userId = user?._id?.toString() || hookConfig.user;
      logger.info(
        `[mcp-webhook:${server}/${hook}] Queueing prompt for user ${userId} (${hookConfig.user})`,
      );
      queue.add(() =>
        processMCPWebhook({
          req,
          name: `${server}/${hook}`,
          userId,
          hookConfig,
          promptContent,
        }),
      );
    }

    // Send response
    res.set('Content-Type', responseContentType);
    return res.status(responseCode).send(responseContent);

  } catch (err) {
    logger.error(`[mcp-webhook:${server}/${hook}] proxy error`, err);
    res.status(502).json({ error: 'Proxy error' });
  }
});


module.exports = router;
