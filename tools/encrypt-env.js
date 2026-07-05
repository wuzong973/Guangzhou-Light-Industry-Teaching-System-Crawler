const crypto = require('crypto');

const value = process.argv[2];
const secret = process.env.CREDENTIAL_SECRET || process.env.APP_SECRET || process.argv[3];

if (!value || !secret) {
  console.error('Usage: CREDENTIAL_SECRET=your-secret node tools/encrypt-env.js "value"');
  console.error('   or: node tools/encrypt-env.js "value" "your-secret"');
  process.exit(1);
}

const key = crypto.createHash('sha256').update(String(secret)).digest();
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([
  cipher.update(String(value), 'utf8'),
  cipher.final(),
]);
const tag = cipher.getAuthTag();

console.log(`${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`);
