import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
writeFileSync('.env', `HOOKRELAY_API_KEY=${randomBytes(32).toString('hex')}\nHOOKRELAY_SIGNING_SECRET=${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
console.log('Created ignored .env. Use HOOKRELAY_API_KEY in the local dashboard; keep both keys private.');
