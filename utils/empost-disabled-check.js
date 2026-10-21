/**
 * Single source of truth for EMPOST API disabled state.
 * Always reads from process.env.EMPOST_API_DISABLED (trimmed, case-insensitive).
 */
function isEmpostDisabled() {
  const v = (process.env.EMPOST_API_DISABLED || '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

module.exports = { isEmpostDisabled };
