const express = require('express');
const crypto = require('crypto');
const PQueue = require('p-queue').default;
const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint } = require('librechat-data-provider');
const { getCustomConfig } = require('~/server/services/Config');
const { loadAgent } = require('~/models/Agent');
const { findUser } = require('~/models');
const AgentController = require('~/server/controllers/agents/request');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const addTitle = require('~/server/services/Endpoints/agents/title');
const { Writable } = require('stream');

const router = express.Router();
const queue = new PQueue({ concurrency: 1 });

function verifyAuth(req, auth, name) {
  if (!auth) {
    return true;
  }

  switch (auth.type) {
    case 'github': {
      const alg = auth.algorithm || 'sha256';
      const signatureHeader = auth.signature_header ||
        (alg === 'sha256' ? 'x-hub-signature-256' : 'x-hub-signature');
      const signature = req.get(signatureHeader);
      if (!signature || !req.rawBody) {
        return false;
      }
      const hmac = crypto.createHmac(alg, auth.secret).update(req.rawBody).digest('hex');
      const expected = `${alg}=${hmac}`;
      try {
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
      } catch {
        return false;
      }
    }
    case 'header': {
      const headerName = auth.header || 'authorization';
      const value = req.get(headerName) || '';
      const expected = auth.prefix ? `${auth.prefix}${auth.secret}` : auth.secret;
      return value === expected;
    }
    case 'microsoft': {
      const clientState = req.body?.value?.[0]?.clientState;
      return clientState === auth.clientState;
    }
    default:
      logger.error(`[webhook:${name}] Invalid auth type: ${auth.type}`);
      return false;
  }
}

async function processWebhook({ req, webhookConfig, name, userId, payload }) {
  try {
    const prefix = webhookConfig.prompt ? `${webhookConfig.prompt}\n\n` : '';
    const text = `${prefix}${JSON.stringify(payload)}`;

    // Reuse the original Express request so req.app.locals and other properties are available
    const agentReq = req;
    agentReq.user = { id: userId };
    agentReq.body = {
      text,
      endpoint: EModelEndpoint.agents,
      agent_id: webhookConfig.agent_id,
      endpointOption: {
        endpoint: EModelEndpoint.agents,
        agent_id: webhookConfig.agent_id,
        agent: loadAgent({
          req: { user: { id: userId } },
          agent_id: webhookConfig.agent_id,
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
  } catch (error) {
    logger.error(`[webhook:${name}] processing failed`, error);
  }
}

router.all('/:name', async (req, res) => {
  const { name } = req.params;
  const config = await getCustomConfig();
  const webhookConfig = config?.webhooks?.[name];

  if (!webhookConfig) {
    return res.status(404).json({ error: 'Webhook not configured' });
  }

  if (req.method === 'GET' && req.query.validationToken) {
    return res.status(200).send(req.query.validationToken);
  }

  if (!verifyAuth(req, webhookConfig.auth, name)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let userId = 'system';
  if (webhookConfig.user) {
    const user = await findUser({ email: webhookConfig.user });
    // If your deployment uses email as the user identifier, the lookup above will simply return the same value
    userId = user?._id?.toString() || webhookConfig.user;
  }

  const payload = req.body;
  res.status(202).json({ ok: true });

  queue.add(() => processWebhook({ req, webhookConfig, name, userId, payload }));
});

module.exports = router;
