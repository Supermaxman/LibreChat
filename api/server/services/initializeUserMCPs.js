const { logger } = require('@librechat/data-schemas');
const { User } = require('~/db/models');
const { CacheKeys, Constants } = require('librechat-data-provider');
const { findToken, updateToken, createToken, deleteTokens } = require('~/models');
const { setCachedTools, getCachedTools, loadCustomConfig } = require('~/server/services/Config');
const { getUserPluginAuthValue } = require('~/server/services/PluginService');
const { getMCPManager, getFlowStateManager } = require('~/config');
const { getLogStores } = require('~/cache');
const { getServerConnectionStatus, getMCPSetupData } = require('~/server/services/MCP');

const reinitializeMCP = async (serverName, userId) => {
  try {
    const user = { id: userId };
    logger.info(`[MCP Reinitialize] Reinitializing server: ${serverName}`);

    const printConfig = false;
    const config = await loadCustomConfig(printConfig);
    if (!config || !config.mcpServers || !config.mcpServers[serverName]) {
      // return res.status(404).json({
      //   error: `MCP server '${serverName}' not found in configuration`,
      // });
      return {
        status: 404,
        content: {
          error: `MCP server '${serverName}' not found in configuration`,
        }
      }
    }

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);
    const mcpManager = getMCPManager();

    await mcpManager.disconnectServer(serverName);
    logger.info(`[MCP Reinitialize] Disconnected existing server: ${serverName}`);

    const serverConfig = config.mcpServers[serverName];
    mcpManager.mcpConfigs[serverName] = serverConfig;
    let customUserVars = {};
    if (serverConfig.customUserVars && typeof serverConfig.customUserVars === 'object') {
      for (const varName of Object.keys(serverConfig.customUserVars)) {
        try {
          const value = await getUserPluginAuthValue(user.id, varName, false);
          customUserVars[varName] = value;
        } catch (err) {
          logger.error(`[MCP Reinitialize] Error fetching ${varName} for user ${user.id}:`, err);
        }
      }
    }

    let userConnection = null;
    let oauthRequired = false;
    let oauthUrl = null;

    try {
      userConnection = await mcpManager.getUserConnection({
        user,
        serverName,
        flowManager,
        customUserVars,
        tokenMethods: {
          findToken,
          updateToken,
          createToken,
          deleteTokens,
        },
        returnOnOAuth: true,
        oauthStart: async (authURL) => {
          logger.info(`[MCP Reinitialize] OAuth URL received: ${authURL}`);
          oauthUrl = authURL;
          oauthRequired = true;
        },
      });

      logger.info(`[MCP Reinitialize] Successfully established connection for ${serverName}`);
    } catch (err) {
      logger.info(`[MCP Reinitialize] getUserConnection threw error: ${err.message}`);
      logger.info(
        `[MCP Reinitialize] OAuth state - oauthRequired: ${oauthRequired}, oauthUrl: ${oauthUrl ? 'present' : 'null'}`,
      );

      const isOAuthError =
        err.message?.includes('OAuth') ||
        err.message?.includes('authentication') ||
        err.message?.includes('401');

      const isOAuthFlowInitiated = err.message === 'OAuth flow initiated - return early';

      if (isOAuthError || oauthRequired || isOAuthFlowInitiated) {
        logger.info(
          `[MCP Reinitialize] OAuth required for ${serverName} (isOAuthError: ${isOAuthError}, oauthRequired: ${oauthRequired}, isOAuthFlowInitiated: ${isOAuthFlowInitiated})`,
        );
        oauthRequired = true;
      } else {
        logger.error(
          `[MCP Reinitialize] Error initializing MCP server ${serverName} for user:`,
          err,
        );
        // return res.status(500).json({ error: 'Failed to reinitialize MCP server for user' });
        return {
          status: 500,
          content: {
            error: 'Failed to reinitialize MCP server for user',
          }
        }
      }
    }

    if (userConnection && !oauthRequired) {
      const userTools = (await getCachedTools({ userId: user.id })) || {};

      const mcpDelimiter = Constants.mcp_delimiter;
      for (const key of Object.keys(userTools)) {
        if (key.endsWith(`${mcpDelimiter}${serverName}`)) {
          delete userTools[key];
        }
      }

      const tools = await userConnection.fetchTools();
      for (const tool of tools) {
        const name = `${tool.name}${Constants.mcp_delimiter}${serverName}`;
        userTools[name] = {
          type: 'function',
          ['function']: {
            name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        };
      }

      await setCachedTools(userTools, { userId: user.id });
    }

    logger.debug(
      `[MCP Reinitialize] Sending response for ${serverName} - oauthRequired: ${oauthRequired}, oauthUrl: ${oauthUrl ? 'present' : 'null'}`,
    );

    const getResponseMessage = () => {
      if (oauthRequired) {
        return `MCP server '${serverName}' ready for OAuth authentication`;
      }
      if (userConnection) {
        return `MCP server '${serverName}' reinitialized successfully`;
      }
      return `Failed to reinitialize MCP server '${serverName}'`;
    };

    // res.json({
    //   success: (userConnection && !oauthRequired) || (oauthRequired && oauthUrl),
    //   message: getResponseMessage(),
    //   serverName,
    //   oauthRequired,
    //   oauthUrl,
    // });
    return {
      status: 200,
      content: {
        success: (userConnection && !oauthRequired) || (oauthRequired && oauthUrl),
        message: getResponseMessage(),
        serverName,
        oauthRequired,
        oauthUrl,
      }
    }
  } catch (error) {
    logger.error('[MCP Reinitialize] Unexpected error', error);
    // res.status(500).json({ error: 'Internal server error' });
    return {
      status: 500,
      content: {
        error: 'Internal server error',
      }
    }
  }
}


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
          const { appConnections, userConnections, oauthServers } = await getMCPSetupData(
            userId,
          );
          // first, check if server is disconnected. if not, no need to reinitialize
          const serverStatus = await getServerConnectionStatus(
            userId,
            serverName,
            appConnections,
            userConnections,
            oauthServers,
          );
          // disconnected, error, connecting, connected, etc.
          // we want to reinitialize if it's disconnected
          if (serverStatus.connectionState !== 'disconnected') {
            logger.info(`[MCP][Startup] Server '${serverName}' has already been initialized for user ${userId}`);
            continue;
          }
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

module.exports = {
  initializeUserMCPs,
  reinitializeMCP,
};


