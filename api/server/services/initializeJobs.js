const { logger } = require('@librechat/data-schemas');
const cron = require('node-cron');
const PQueue = require('p-queue').default;
const { EModelEndpoint, Constants, extractEnvVariable } = require('librechat-data-provider');
const { getCustomConfig } = require('~/server/services/Config');
const { loadAgent } = require('~/models/Agent');
const { findUser } = require('~/models');
const AgentController = require('~/server/controllers/agents/request');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const addTitle = require('~/server/services/Endpoints/agents/title');
const { Writable } = require('stream');

const queue = new PQueue({ concurrency: 1 });

function resolveEnvValue(value) {
  if (typeof value !== 'string') return value;
  return extractEnvVariable(value);
}

function resolveConfigDeep(input) {
  if (input == null) return input;
  if (typeof input === 'string') return resolveEnvValue(input);
  if (Array.isArray(input)) return input.map((v) => resolveConfigDeep(v));
  if (typeof input === 'object') {
    const out = Array.isArray(input) ? [] : {};
    for (const k of Object.keys(input)) {
      out[k] = resolveConfigDeep(input[k]);
    }
    return out;
  }
  return input;
}

async function runScheduledJob({ jobName, userId, agent_id, prompt, appLocals }) {
  try {
    logger.info(`[jobs:${jobName}] Running for user ${userId} - agent ${agent_id}`);

    const text = prompt ?? '';

    /** @type {any} */
    const req = {};
    req.user = { id: userId };
    req.app = { locals: appLocals || {} };
    req.originTag = 'Automated';
    req.body = {
      text,
      endpoint: EModelEndpoint.agents,
      agent_id,
      parentMessageId: Constants.NO_PARENT,
      endpointOption: {
        endpoint: EModelEndpoint.agents,
        agent_id,
        agent: loadAgent({
          req: { user: { id: userId } },
          agent_id,
          endpoint: EModelEndpoint.agents,
        }),
        model_parameters: {},
      },
    };

    const res = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    res.write = () => {};
    res.end = () => {};
    res.setHeader = () => {};
    res.status = () => res;
    res.json = () => {};
    res.on = () => {};
    res.removeListener = () => {};

    await AgentController(req, res, () => {}, initializeClient, addTitle);
    logger.info(`[jobs:${jobName}] Completed for user ${userId}`);
  } catch (err) {
    logger.error(`[jobs:${jobName}] Failed`, err);
  }
}

/**
 * Initialize cron-based jobs from config.jobs
 * @param {import('express').Application} _app
 */
async function initializeJobs(_app) {
  const appLocals = _app?.locals ?? {};
  const config = await getCustomConfig();
  const jobs = resolveConfigDeep(config?.jobs || {});
  const names = Object.keys(jobs);
  if (names.length === 0) {
    logger.info('[jobs] No jobs configured');
    return;
  }

  logger.info(`[jobs] Initializing ${names.length} job(s)`);
  for (const name of names) {
    const job = jobs[name];
    if (!job) continue;
    if (job.enabled === false) {
      logger.info(`[jobs:${name}] Disabled; skipping`);
      continue;
    }

    const schedule = job.schedule;
    if (!schedule || typeof schedule !== 'string') {
      logger.warn(`[jobs:${name}] Invalid or missing schedule; skipping`);
      continue;
    }

    if (!cron.validate(schedule)) {
      logger.warn(`[jobs:${name}] Schedule not a valid cron expression: ${schedule}; skipping`);
      continue;
    }

    // Resolve user id
    
    const user = await findUser({ email: job.user });
    const userId = user?._id?.toString() || job.user;

    const task = () =>
      queue.add(() =>
        runScheduledJob({
          jobName: name,
          userId,
          agent_id: job.agent_id,
          prompt: job.prompt,
          appLocals,
        }),
      );

    try {
      cron.schedule(schedule, task, {
        timezone: job.timezone,
      });
      logger.info(
        `[jobs:${name}] Scheduled with "${schedule}"${job.timezone ? ` (${job.timezone})` : ''}`,
      );
    } catch (e) {
      logger.error(`[jobs:${name}] Failed to schedule`, e);
    }
  }
}

module.exports = initializeJobs;


