const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { chatWithNvidia, serviceDownReply } = require('../services/nvidia-chat');

router.post('/chat', auth, async (req, res) => {
  try {
    const result = await chatWithNvidia({
      messages: req.body?.messages,
      firstName:
        req.body?.firstName ||
        req.user?.employee?.full_name?.split?.(' ')?.[0] ||
        req.user?.email?.split?.('@')?.[0],
      department: req.body?.department || req.user?.department?.name,
      role: req.user?.role,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    if (error.code === 'EMPTY_MESSAGE') {
      return res.status(400).json({ success: false, error: 'Type a message first.' });
    }
    console.warn('[ai/chat]', error.response?.status || error.message);
    res.json({
      success: true,
      data: {
        reply: serviceDownReply(error),
        fallback: true,
      },
    });
  }
});

module.exports = router;
