const {
  CAPABILITIES,
  DEFAULT_PERMISSION_MATRIX,
} = require('./constants');

const ROLE_RANK = { USER: 1, ADMIN: 2, SUPERADMIN: 3 };

function normalizeRole(role) {
  const value = String(role || '').toUpperCase();
  return ROLE_RANK[value] ? value : 'USER';
}

function cloneMatrix(matrix) {
  const source = matrix && typeof matrix === 'object' ? matrix : DEFAULT_PERMISSION_MATRIX;
  const out = {};
  for (const role of ['SUPERADMIN', 'ADMIN', 'USER']) {
    out[role] = {};
    const row = source[role] || DEFAULT_PERMISSION_MATRIX[role];
    for (const cap of CAPABILITIES) {
      const fallback = DEFAULT_PERMISSION_MATRIX[role][cap] === true;
      out[role][cap] = row[cap] == null ? fallback : row[cap] === true;
    }
  }
  return out;
}

function capabilityEnabled(matrix, role, capability) {
  const normalized = normalizeRole(role);
  const cloned = cloneMatrix(matrix);
  if (!CAPABILITIES.includes(capability)) return false;
  return cloned[normalized][capability] === true;
}

function canAssignRole(actorRole, targetCurrentRole, nextRole) {
  const actor = normalizeRole(actorRole);
  const current = normalizeRole(targetCurrentRole);
  const next = normalizeRole(nextRole);
  if (ROLE_RANK[next] > ROLE_RANK[actor]) {
    return { ok: false, error: 'You cannot grant a role higher than your own.' };
  }
  if (actor !== 'SUPERADMIN' && next === 'SUPERADMIN') {
    return { ok: false, error: 'Only a Super Admin can assign the Super Admin role.' };
  }
  if (actor !== 'SUPERADMIN' && current === 'SUPERADMIN') {
    return { ok: false, error: 'Only a Super Admin can change a Super Admin account.' };
  }
  return { ok: true };
}

function canGrantCapabilities(actorRole, actorCaps, requestedCaps) {
  const actor = normalizeRole(actorRole);
  if (actor === 'SUPERADMIN') return { ok: true };
  const requested = requestedCaps && typeof requestedCaps === 'object' ? requestedCaps : {};
  for (const cap of CAPABILITIES) {
    if (requested[cap] === true && actorCaps[cap] !== true) {
      return {
        ok: false,
        error: `You cannot grant the ${cap} permission because you do not hold it.`,
      };
    }
  }
  return { ok: true };
}

function preventSelfEscalation(actor, targetUserId, nextRole, nextCaps) {
  const actorId = String(actor?.id || actor?._id || '');
  const targetId = String(targetUserId || '');
  if (actorId && targetId && actorId === targetId) {
    const currentRole = normalizeRole(actor.role);
    const desiredRole = nextRole != null ? normalizeRole(nextRole) : currentRole;
    if (ROLE_RANK[desiredRole] > ROLE_RANK[currentRole]) {
      return { ok: false, error: 'You cannot raise your own role.' };
    }
    const currentCaps = actor.capabilities || cloneMatrix()[currentRole];
    if (nextCaps && typeof nextCaps === 'object') {
      for (const cap of CAPABILITIES) {
        if (nextCaps[cap] === true && currentCaps[cap] !== true) {
          return { ok: false, error: 'You cannot grant yourself additional finance permissions.' };
        }
      }
    }
  }
  return { ok: true };
}

function sanitizeMatrixPatch(incoming) {
  return cloneMatrix(incoming);
}

module.exports = {
  ROLE_RANK,
  normalizeRole,
  cloneMatrix,
  capabilityEnabled,
  canAssignRole,
  canGrantCapabilities,
  preventSelfEscalation,
  sanitizeMatrixPatch,
};
