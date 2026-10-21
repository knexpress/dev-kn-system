const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const auth = require('../middleware/auth');
const { requireCapability } = require('../middleware/finance-permissions');
const setup = require('../services/finance-setup');
const opening = require('../services/finance-setup/opening-balances');
const { runWorkflowValidation } = require('../services/finance-setup/workflow');
const { getDriveRefreshTokenStatus } = require('../services/system-settings');

const router = express.Router();
const uploadDir = path.join(__dirname, '..', 'uploads', 'finance-setup');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
      cb(null, `logo${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (String(file.mimetype || '').startsWith('image/')) return cb(null, true);
    cb(new Error('Logo must be an image file.'));
  },
});

const manage = [auth, requireCapability('manage_setup', { always: true })];
const view = [auth, requireCapability('manage_setup', { always: true })];

function handle(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error('Finance setup error:', error);
  res.status(status).json({
    success: false,
    error: error.statusCode ? error.message : 'Finance setup request failed',
    details: error.message,
  });
}

router.get('/', ...view, async (req, res) => {
  try {
    const data = await setup.dashboard(req);
    res.json({ success: true, data });
  } catch (error) {
    handle(res, error);
  }
});

router.get('/audit', ...view, async (req, res) => {
  try {
    const data = await setup.listAudit(req.query.limit);
    res.json({ success: true, data });
  } catch (error) {
    handle(res, error);
  }
});

router.get('/document-preview', ...view, async (req, res) => {
  try {
    const doc = await setup.getOrCreateSetup();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(setup.documentPreviewHtml(doc));
  } catch (error) {
    handle(res, error);
  }
});

router.put('/profile', ...manage, async (req, res) => {
  try {
    const data = await setup.saveProfile(req.body, setup.actorFrom(req));
    res.json({ success: true, data, message: 'Business profile saved.' });
  } catch (error) {
    handle(res, error);
  }
});

router.post('/profile/logo', ...manage, logoUpload.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Choose an image file to upload.' });
    }
    const logoUrl = `/uploads/finance-setup/${req.file.filename}`;
    const data = await setup.saveProfile({ logo_url: logoUrl }, setup.actorFrom(req));
    res.json({ success: true, data, message: 'Logo uploaded.' });
  } catch (error) {
    handle(res, error);
  }
});

router.put('/foundations', ...manage, async (req, res) => {
  try {
    const data = await setup.saveFoundations(req.body, setup.actorFrom(req));
    res.json({ success: true, data, message: 'Accounting foundations saved.' });
  } catch (error) {
    handle(res, error);
  }
});

router.put('/permissions', ...manage, async (req, res) => {
  try {
    const data = await setup.savePermissions(req.body, setup.actorFrom(req));
    res.json({ success: true, data, message: 'Permissions saved.' });
  } catch (error) {
    handle(res, error);
  }
});

router.put('/approvals', ...manage, async (req, res) => {
  try {
    const data = await setup.saveApprovals(req.body, setup.actorFrom(req));
    res.json({ success: true, data, message: 'Approval policies saved.' });
  } catch (error) {
    handle(res, error);
  }
});

router.put('/mappings', ...manage, async (req, res) => {
  try {
    const data = await setup.saveMappings(req.body, setup.actorFrom(req));
    res.json({ success: true, data, message: 'Account mappings saved.' });
  } catch (error) {
    handle(res, error);
  }
});

router.put('/steps/:stepKey/not-applicable', ...manage, async (req, res) => {
  try {
    const data = await setup.markNotApplicable(req.params.stepKey, req.body?.reason, setup.actorFrom(req));
    res.json({ success: true, data, message: 'Step marked not applicable.' });
  } catch (error) {
    handle(res, error);
  }
});

router.delete('/steps/:stepKey/not-applicable', ...manage, async (req, res) => {
  try {
    const data = await setup.clearNotApplicable(req.params.stepKey, setup.actorFrom(req));
    res.json({ success: true, data });
  } catch (error) {
    handle(res, error);
  }
});

router.put('/steps/:stepKey/responsible', ...manage, async (req, res) => {
  try {
    const data = await setup.assignResponsible(req.params.stepKey, req.body || {}, setup.actorFrom(req));
    res.json({ success: true, data });
  } catch (error) {
    handle(res, error);
  }
});

router.put('/steps/:stepKey/review', ...manage, async (req, res) => {
  try {
    const data = await setup.reviewStep(req.params.stepKey, req.body?.comments, setup.actorFrom(req));
    res.json({ success: true, data, message: 'Review recorded.' });
  } catch (error) {
    handle(res, error);
  }
});

router.get('/opening-balances/template/:kind', ...view, async (req, res) => {
  try {
    const templates = opening.openingTemplates();
    const csv = templates[req.params.kind];
    if (!csv) return res.status(404).json({ success: false, error: 'Unknown template.' });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.kind}.csv"`);
    res.send(csv);
  } catch (error) {
    handle(res, error);
  }
});

router.get('/opening-balances', ...view, async (req, res) => {
  try {
    const data = await opening.listBatches();
    res.json({ success: true, data });
  } catch (error) {
    handle(res, error);
  }
});

router.post('/opening-balances/preview', ...manage, async (req, res) => {
  try {
    const data = await opening.preview(req.body, setup.actorFrom(req));
    if (data.error) {
      return res.status(data.statusCode || 400).json({ success: false, error: data.error, data });
    }
    res.json({ success: true, data, message: data.validation?.ok ? 'Opening file is valid and waiting for approval.' : 'Fix the listed errors before approval.' });
  } catch (error) {
    handle(res, error);
  }
});

router.post('/opening-balances/:batchId/approve', ...manage, async (req, res) => {
  try {
    const data = await opening.approveAndPost(req.params.batchId, setup.actorFrom(req));
    res.json({
      success: true,
      data,
      message: data.duplicated
        ? 'This batch was already posted. Nothing was duplicated.'
        : `Posted opening journal ${data.journal?.entry_no || ''}.`.trim(),
    });
  } catch (error) {
    handle(res, error);
  }
});

router.post('/opening-balances/:batchId/reverse', ...manage, async (req, res) => {
  try {
    const data = await opening.reverseBatch(req.params.batchId, req.body?.reason, setup.actorFrom(req));
    res.json({ success: true, data, message: 'Opening batch reversed with a compensating journal.' });
  } catch (error) {
    handle(res, error);
  }
});

router.post('/workflow-validation/run', ...manage, async (req, res) => {
  try {
    const data = await runWorkflowValidation(setup.actorFrom(req), req.body?.manual || {});
    res.json({ success: true, data, message: data.note });
  } catch (error) {
    handle(res, error);
  }
});

router.post('/integrations/google-drive/check', ...manage, async (req, res) => {
  try {
    const status = await getDriveRefreshTokenStatus();
    let connected = false;
    let warning = null;
    if (status.configured) {
      try {
        const googleDrive = require('../services/google-drive');
        await googleDrive.testConnection();
        connected = true;
      } catch (err) {
        warning = err.message || 'Connection check failed.';
      }
    }
    res.json({
      success: true,
      data: {
        configured: status.configured === true,
        connected,
        source: status.source,
        hint: status.hint,
        warning,
      },
      message: connected
        ? 'Google Drive responded to a connection check.'
        : status.configured
          ? 'A token is saved, but the connection check failed.'
          : 'Google Drive is not configured.',
    });
  } catch (error) {
    handle(res, error);
  }
});

router.put('/backup-review', ...manage, async (req, res) => {
  try {
    const data = await setup.saveBackupReview(req.body, setup.actorFrom(req));
    res.json({ success: true, data, message: 'Backup review recorded.' });
  } catch (error) {
    handle(res, error);
  }
});

router.post('/go-live/approve', ...manage, async (req, res) => {
  try {
    const data = await setup.approveGoLive(req.body, setup.actorFrom(req));
    res.json({ success: true, data, message: 'Go-live approved. Existing operations were not automatically blocked.' });
  } catch (error) {
    handle(res, error);
  }
});

module.exports = router;
