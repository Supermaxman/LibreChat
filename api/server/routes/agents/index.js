const express = require('express');
const {
  uaParser,
  checkBan,
  requireJwtAuth,
  messageIpLimiter,
  concurrentLimiter,
  messageUserLimiter,
} = require('~/server/middleware');
const { isEnabled } = require('~/server/utils');
const { v1 } = require('./v1');
const chat = require('./chat');
const { searchConversation } = require('~/models/Conversation');
const abortControllers = require('~/server/middleware/abortControllers');

const { LIMIT_CONCURRENT_MESSAGES, LIMIT_MESSAGE_IP, LIMIT_MESSAGE_USER } = process.env ?? {};

const router = express.Router();

router.use(requireJwtAuth);
router.use(checkBan);
router.use(uaParser);

router.use('/', v1);
// Agent run status endpoint

router.get('/status/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user?.id;

    if (!conversationId || !userId) {
      return res.status(400).json({ running: false });
    }

    const convo = await searchConversation(conversationId);
    if (!convo || convo.user !== userId) {
      return res.status(404).json({ running: false });
    }

    let running = false;
    if (abortControllers.has(conversationId)) {
      running = true;
    } else {
      for (const key of abortControllers.keys()) {
        if (typeof key === 'string' && key.startsWith(conversationId + ':')) {
          running = true;
          break;
        }
      }
    }

    return res.json({ running });
  } catch (err) {
    return res.status(500).json({ running: false });
  }
});


const chatRouter = express.Router();
if (isEnabled(LIMIT_CONCURRENT_MESSAGES)) {
  chatRouter.use(concurrentLimiter);
}

if (isEnabled(LIMIT_MESSAGE_IP)) {
  chatRouter.use(messageIpLimiter);
}

if (isEnabled(LIMIT_MESSAGE_USER)) {
  chatRouter.use(messageUserLimiter);
}

chatRouter.use('/', chat);
router.use('/chat', chatRouter);

module.exports = router;
