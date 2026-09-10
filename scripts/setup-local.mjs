import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync('.dev.vars')) {
  writeFileSync('.dev.vars', `ADMIN_TOKEN="${randomBytes(32).toString('base64url')}"\nENCRYPTION_KEY="${randomBytes(32).toString('base64')}"\nCF_AI_TOKEN=""\nCF_AIG_TOKEN=""\nCF_API_TOKEN=""\n`, { mode: 0o600 });
  console.log('Created .dev.vars with unique local secrets. Read ADMIN_TOKEN in that file to sign in.');
} else {
  console.log('.dev.vars already exists; keeping your configuration.');
}
