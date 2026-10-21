const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  canAssignRole,
  preventSelfEscalation,
  capabilityEnabled,
  cloneMatrix,
} = require('../../services/finance-setup/permissions-core');

describe('finance setup permissions', () => {
  it('stops an admin assigning superadmin', () => {
    const result = canAssignRole('ADMIN', 'USER', 'SUPERADMIN');
    assert.equal(result.ok, false);
  });

  it('allows superadmin to assign admin', () => {
    const result = canAssignRole('SUPERADMIN', 'USER', 'ADMIN');
    assert.equal(result.ok, true);
  });

  it('prevents a user raising their own role', () => {
    const result = preventSelfEscalation(
      { id: '1', role: 'USER', capabilities: { view: true } },
      '1',
      'ADMIN'
    );
    assert.equal(result.ok, false);
  });

  it('prevents granting a capability the actor does not hold', () => {
    const result = preventSelfEscalation(
      { id: '1', role: 'ADMIN', capabilities: { approve: true, manage_setup: false } },
      '1',
      'ADMIN',
      { manage_setup: true }
    );
    assert.equal(result.ok, false);
  });

  it('defaults keep current operator access', () => {
    const matrix = cloneMatrix();
    assert.equal(capabilityEnabled(matrix, 'USER', 'create'), true);
    assert.equal(capabilityEnabled(matrix, 'USER', 'unlock_period'), false);
    assert.equal(capabilityEnabled(matrix, 'ADMIN', 'approve'), true);
  });
});
