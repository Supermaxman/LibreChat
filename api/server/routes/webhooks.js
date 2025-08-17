const express = require('express');
const PQueue = require('p-queue').default;
const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint, Constants, CacheKeys, extractEnvVariable } = require('librechat-data-provider');
const { getCustomConfig } = require('~/server/services/Config');
const { loadAgent } = require('~/models/Agent');
const { findUser, findToken, createToken, updateToken, deleteTokens } = require('~/models');
const AgentController = require('~/server/controllers/agents/request');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const addTitle = require('~/server/services/Endpoints/agents/title');
const { Writable } = require('stream');
const { getFlowStateManager, getMCPManager } = require('~/config');
const { getLogStores } = require('~/cache');
const { MCPTokenStorage, MCPOAuthHandler } = require('@librechat/api');


const router = express.Router();
const processQueue = new PQueue({ concurrency: 1 });
const promptQueue = new PQueue({ concurrency: 1 });


function resolveEnvValue(value, name, keyPath) {
  if (typeof value !== 'string') {
    return value;
  }
  const resolved = extractEnvVariable(value);
  return resolved;
}


async function processWebhookData({ server, hook, hookConfig, serverConfig, processData }) {
  try {
    const user = await findUser({ email: hookConfig.user });
    const userId = user?._id?.toString() || hookConfig.user;
    logger.info(`[mcp-webhook:${server}/${hook}/process] Starting webhook processing for user ${userId}`);
    const processUrl = buildTargetWebhookProcessUrl({ baseUrl: serverConfig.url, hook });
    
    const headers = {
      'Content-Type': 'application/json',
      'x-mcp-name': server,
    };
    // Inject x-mcp-authentication header using OAuth tokens for the configured user
    try {
      // TODO better way to first verify if a server has OAuth enabled?
      const flowsCache = getLogStores(CacheKeys.FLOWS);
      const flowManager = getFlowStateManager(flowsCache);
      
      logger.info(`[mcp-webhook:${server}/${hook}/process] Getting user token for user ${userId}`);
      
      /** Refresh function for user-specific connections */
      const refreshTokensFunction = async (
        refreshToken,
        metadata,
      ) => {
        /** URL from config since connection doesn't exist yet */
        const serverUrl = serverConfig.url;
        return await MCPOAuthHandler.refreshOAuthTokens(
          refreshToken,
          {
            serverName: metadata.serverName,
            serverUrl,
            clientInfo: metadata.clientInfo,
          },
          serverConfig.oauth,
        );
      };

      /** Flow state to prevent concurrent token operations */
      const tokenFlowId = `tokens:${userId}:${server}`;
      const tokens = await flowManager.createFlowWithHandler(
        tokenFlowId,
        'mcp_get_tokens',
        async () => {
          return await MCPTokenStorage.getTokens({
            userId,
            serverName: server,
            findToken: findToken,
            refreshTokens: refreshTokensFunction,
            createToken: createToken,
            updateToken: updateToken,
            deleteTokens: deleteTokens,
          });
        },
      );

      if (tokens?.access_token) {
        headers['Authorization'] = `Bearer ${tokens.access_token}`;
        logger.info(`[mcp-webhook:${server}/${hook}/process] OAuth tokens found for user ${userId} expires at ${tokens.expires_at} seconds`);
      } else {
        logger.warn(`[mcp-webhook:${server}/${hook}/process] No OAuth tokens found for user ${userId}`);
      }      
    } catch (authErr) {
      logger.warn(`[mcp-webhook:${server}/${hook}/process] Failed to attach OAuth token header`, authErr);
    }
    
    const controller = new AbortController();
    const timeoutMs = serverConfig.timeout ?? serverConfig.initTimeout ?? 30000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(processUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(processData),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (response.status !== 200) {
      logger.error(`[mcp-webhook:${server}/${hook}/process] Received non-200 response: ${response.status}`);
      return;
    }
    
    const data = await response.json();

    const promptContent = data.promptContent;
    logger.info(`[mcp-webhook:${server}/${hook}/process] Received 200 response: ${promptContent ? 'with prompt' : 'without prompt'}`);
    // Enqueue prompt processing if present
    if (promptContent) {
      logger.info(
        `[mcp-webhook:${server}/${hook}/process] Queueing prompt for user ${userId} (${hookConfig.user})`,
      );
      promptQueue.add(() =>
        processMCPWebhook({
          req,
          name: `${server}/${hook}`,
          userId,
          hookConfig,
          promptContent,
        }),
      );
    }
    
  } catch (error) {
    logger.error(`[mcp-webhook:${server}/${hook}/process] Processing failed`, error);
  }

  

}


async function processMCPWebhook({ req, name, userId, hookConfig, promptContent }) {
  try {
    logger.info(`[mcp-webhook:${name}/prompt] Starting prompt for user ${userId}`);
    const prefix = hookConfig.prompt ? `${hookConfig.prompt}\n\n` : '';
    const text = `${prefix}${promptContent ?? ''}`;

    const agentReq = req;
    agentReq.user = { id: userId };
    // Mark webhook-initiated chats as Automated for auto-tagging
    agentReq.originTag = 'Automated';
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
    logger.info(`[mcp-webhook:${name}/prompt] Processed prompt for user ${userId}`);
  } catch (error) {
    logger.error(`[mcp-webhook:${name}/prompt] Processing failed`, error);
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


function buildTargetWebhookProcessUrl({ baseUrl, hook, query }) {
  const urlObj = new URL(baseUrl);
  // remove trailing /mcp if present  
  urlObj.pathname = urlObj.pathname.replace(/\/?mcp\/?$/i, '/');
  // ensure no trailing slash before appending
  const basePath = urlObj.pathname.replace(/\/$/, '');
  const target = new URL(`${urlObj.origin}${basePath}/webhooks/${encodeURIComponent(hook)}/process`);
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


function prepareProxyHeaders(incomingHeaders, extraHeaders, server) {
  const out = { ...incomingHeaders };
  // override/merge with configured headers last
  Object.assign(out, extraHeaders || {});
  // remove hop-by-hop headers and ones we will let undici/node compute
  delete out['host'];
  delete out['content-length'];
  delete out['connection'];
  delete out['accept-encoding'];
  // add MCP server name to headers
  out['x-mcp-name'] = server;
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
  logger.info(`[mcp-webhook:${server}/${hook}/proxy] Starting proxy`);
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
    const headers = prepareProxyHeaders(req.headers, serverConfig.headers, server);

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
      logger.info(`[mcp-webhook:${server}/${hook}/proxy] Received non-200 upstream response: ${response.status}`);
      res.set('Content-Type', upstreamContentType);
      if (response.status === 400) {
        logger.info(`[mcp-webhook:${server}/${hook}/proxy] Received 400 upstream response: ${response.status}`);
        return res.status(204).send(upstreamText);
      }
      return res.status(response.status).send(upstreamText);
    }

    const data = await response.json();


    // Prepare planned response (send after queueing)
    const responseCode = data.reqResponseCode;
    const responseContentType = data.reqResponseContentType === 'json' ? 'application/json' : 'text/plain';
    const responseContent = data.reqResponseContent;
    const processData = data.processData;
    
    logger.info(`[mcp-webhook:${server}/${hook}/proxy] Received 200 upstream response: ${responseContentType} ${responseCode}`);

    if (processData) {
      logger.info(`[mcp-webhook:${server}/${hook}/proxy] Queueing process for user ${hookConfig.user}`);
      processQueue.add(() =>
        processWebhookData({
          server,
          hook,
          hookConfig,
          serverConfig,
          processData,
        }),
      );
    }

    res.set('Content-Type', responseContentType);
    return res.status(responseCode).send(responseContent);

  } catch (err) {
    logger.error(`[mcp-webhook:${server}/${hook}/proxy] proxy error`, err);
    res.status(502).json({ error: 'Proxy error' });
  }
});


module.exports = router;
