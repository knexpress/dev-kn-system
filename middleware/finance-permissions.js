const { User } = require('../models');
const { FinanceSetup } = require('../models/finance-setup');
const {
  capabilityEnabled,
  cloneMatrix,
  normalizeRole,
} = require('../services/finance-setup/permissions-core');

function departmentNameOf(user) {
  const dept = user?.department;
  if (dept && typeof dept === 'object') return dept.name || '';
  return String(dept || '');
}

async function loadSetupDoc() {
  return FinanceSetup.findOne({ key: 'global' }).lean();
}

async function actorCapabilities(req) {
  if (!req.user) return { role: 'USER', caps: cloneMatrix().USER, enforcement: false };
  const role = normalizeRole(req.user.role);
  const setup = await loadSetupDoc();
  const matrix = cloneMatrix(setup?.permission_matrix);
  const caps = { ...matrix[role] };
  const overrides = req.user.finance_capabilities;
  if (overrides && typeof overrides === 'object') {
    Object.keys(caps).forEach((key) => {
      if (typeof overrides[key] === 'boolean') caps[key] = overrides[key];
    });
  }
  return {
    role,
    caps,
    enforcement: setup?.permission_enforcement_enabled === true,
    matrix,
  };
}

function requireCapability(capability, options = {}) {
  const always = options.always === true;
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }
      if (!req.user.role || req.user.finance_capabilities == null) {
        const user = await User.findById(req.user.id).select('role isActive finance_capabilities');
        if (user) {
          req.user.role = user.role;
          req.user.finance_capabilities = user.finance_capabilities;
          req.user.isActive = user.isActive;
        }
      }
      const info = await actorCapabilities(req);
      req.financePermissions = info;

      if (capability === 'unlock_period') {
        if (info.role !== 'SUPERADMIN' && info.role !== 'ADMIN') {
          return res.status(403).json({
            success: false,
            error: 'Period lock changes require an Admin or Super Admin.',
          });
        }
      }

      if (capability === 'manage_setup') {
        const dept = departmentNameOf(req.user);
        const allowedDept = ['Finance', 'IT', 'Management', 'Auditor'].includes(dept);
        if (info.role !== 'SUPERADMIN' && info.role !== 'ADMIN' && !allowedDept) {
          return res.status(403).json({
            success: false,
            error: 'Finance setup is limited to finance administrators.',
          });
        }
      }

      const mustEnforce = always || info.enforcement;
      if (mustEnforce && !capabilityEnabled(info.matrix, info.role, capability) && info.caps[capability] !== true) {
        return res.status(403).json({
          success: false,
          error: `You do not have the ${capability.replace('_', ' ')} permission.`,
        });
      }
      next();
    } catch (error) {
      console.error('requireCapability error:', error);
      res.status(500).json({ success: false, error: 'Failed to check permissions' });
    }
  };
}

module.exports = {
  requireCapability,
  actorCapabilities,
  loadSetupDoc,
};
