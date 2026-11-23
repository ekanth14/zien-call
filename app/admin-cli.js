'use strict';
// Create or update an admin account. The password is read from stdin so it never
// appears in the process list or shell history.
//   printf '%s' 'PASSWORD' | docker compose exec -T webapp node admin-cli.js <username>
const crypto = require('crypto');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const username = String(process.argv[2] || '').trim().toLowerCase();
if (!/^[a-z0-9_.-]{3,20}$/.test(username)) { console.error('Usage: node admin-cli.js <username>  (password on stdin)'); process.exit(1); }

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const password = input.replace(/\r?\n$/, '');
  if (password.length < 8) { console.error('Password must be at least 8 characters'); process.exit(1); }
  const salt = crypto.randomBytes(16);
  const pass = salt.toString('hex') + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
  const db = new DatabaseSync(path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'zien.db'));
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (u) {
    db.prepare('UPDATE users SET pass = ?, is_admin = 1, legacy = 0 WHERE id = ?').run(pass, u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    console.log(`Updated admin "${username}" (old sessions signed out)`);
  } else {
    db.prepare('INSERT INTO users(username, pass, is_admin, legacy, created) VALUES (?, ?, 1, 0, ?)').run(username, pass, Date.now());
    console.log(`Created admin "${username}"`);
  }
});
