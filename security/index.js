/**
 * Security Module - Unified Exports
 */

const vault = require('./vault');
const redactor = require('./redactor');
const executor = require('./executor');

module.exports = {
  // Vault
  vault: vault.vault,
  initVault: vault.init,
  setSecret: vault.set,
  getSecretRef: vault.ref,
  listSecrets: vault.list,
  deleteSecret: vault.delete,
  getSecretInternal: vault.getInternal,
  getAuditLog: vault.getAuditLog,
  setSecretPermissions: vault.setPermissions,

  // Redactor
  redactor: redactor.redactor,
  redact: redactor.redact,
  clean: redactor.clean,
  addRedactionPattern: redactor.addPattern,
  createSafeLogger: redactor.createSafeLogger,

  // Executor
  SecureExecutor: executor.SecureExecutor,
  createExecutor: executor.createExecutor
};
