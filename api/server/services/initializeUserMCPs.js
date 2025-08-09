const { logger } = require('@librechat/data-schemas');
const { User } = require('~/db/models');
const { reinitializeMCP } = require('~/server/routes/mcp');

/**
 * Initialize user-scoped MCP connections on server startup.
 * Supports per-server config keys in custom YAML under mcpServers:
 * - startupUsers: 'all' | string[]  (user IDs)
 * - startupUser: string             (single user ID)
 * - startup: false                  (respected; skips server)
 *
 * For targets, attempts a silent connection using stored tokens.
 * If OAuth is required, it skips without starting an interactive flow.
 *
 * @param {import('express').Application} app - Express app instance
 */
async function initializeUserMCPs(app) {
  try {
    const mcpServers = app.locals.mcpConfig;
    if (!mcpServers) {
      return;
    }
    logger.info('Initializing user-scoped MCP servers...');

    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      // Respect startup: false
      if (serverConfig?.startup === false) {
        logger.info(`[MCP][Startup] Skipping user init for '${serverName}' due to startup: false`);
        continue;
      }
      // default to all users
      const users = await User.find({}, { _id: 1 }).lean();
      const targetUserIds = users.map((u) => String(u._id));

      if (targetUserIds.length === 0) {
        logger.info(`[MCP][Startup] No users found for '${serverName}'`);
        continue;
      }

      logger.info(
        `[MCP][Startup] User-scoped init for '${serverName}' (users: ${
          serverConfig.startupUsers === 'all' ? 'all' : targetUserIds.length
        })`,
      );

      // Iterate users sequentially to avoid thundering herd on providers
      for (const userId of targetUserIds) {
        try {
          const result = await reinitializeMCP(serverName, userId);
          if (result.status === 200) {
            if (result.content.oauthRequired) {
              logger.info(`[MCP][Startup] OAuth required for '${serverName}' for user ${userId}`);
            } else if (result.content.success) {
              logger.info(`[MCP][Startup] Successfully reinitialized '${serverName}' for user ${userId}`);
            } else {
              logger.error(`[MCP][Startup] Failed to reinitialize '${serverName}' for user ${userId}`);
            }
          } else {
            logger.error(`[MCP][Startup] Failed to reinitialize '${serverName}' for user ${userId}: ${result.content.error}`);
          }
        } catch (error) {
          logger.error(`[MCP][Startup] Failed to reinitialize '${serverName}' for user ${userId}`, error);
        }
      }
    }
  } catch (error) {
    logger.error('[MCP][Startup] Failed user-scoped initialization', error);
  }
}

module.exports = initializeUserMCPs;


