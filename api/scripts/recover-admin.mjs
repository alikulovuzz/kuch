// Run with the API stopped. Read the new password from stdin, never command arguments or logs.
import { store } from '../store/index.js';
import { hashPassword, passwordProblem, nameKey } from '../password.js';
import { dropDeviceLinks } from '../device-link.js';

try {
  if (!/^(1|true|yes|on)$/i.test(process.env.PASSWORD_LOGIN || '')) throw new Error('Enable PASSWORD_LOGIN for operator recovery and subsequent sign-in.');
  const id = process.argv[2];
  if (!id) throw new Error('Usage: recover-admin.mjs PROFILE_ID (password on stdin; stop the API first)');
  const db = await store.loadDb();
  const user = db.users.find(u => u.id === id);
  const configured = (process.env.ADMIN_UIDS || '').split(',').map(v => v.trim());
  if (!user || !(user.admin || configured.includes(id))) throw new Error('Select an existing administrator; recovery never grants a role.');
  if (user.disabled) throw new Error('Disabled profiles require an explicit operator policy decision before recovery.');
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 2048) throw new Error('Password input is too long.'); }
  const password = input.replace(/\r?\n$/, '');
  const problem = passwordProblem(password, user.name);
  if (problem) throw new Error('Password rejected: ' + problem);
  const key = nameKey(user.name);
  if (db.users.some(u => u.id !== id && (u.email === key || (u.pw || u.pwReset?.exp > Date.now()) && nameKey(u.name) === key))) throw new Error('A conflicting sign-in name must be resolved before recovery.');
  user.pw = { h: await hashPassword(password), set: new Date().toISOString() };
  user.sv = (user.sv || 0) + 1;
  delete user.pwReset; delete user.emailRecovery; delete user.emailVerification;
  dropDeviceLinks(db, user.id);
  await store.saveDb(db);
  console.log('Existing administrator recovered; old browser and paired-mobile sessions revoked. Restart the API and sign in.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await store.close(); }
