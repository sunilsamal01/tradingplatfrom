// Sets the admin password through the audited provisioning script, then revokes
// every live session for that account so the leaked password cannot keep a
// foothold. Nothing sensitive is printed.
import dotenv from 'dotenv';
import { spawnSync } from 'node:child_process';
import mongoose from 'mongoose';

dotenv.config();

const EMAIL = 'hello@sololevelingtrad.online';
const PASSWORD = process.argv[2];
if (!PASSWORD) { console.error('password required as argv[2]'); process.exit(1); }

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('MONGODB_URI missing from backend/.env'); process.exit(1); }

// The sandbox cannot resolve Atlas SRV records, so resolve them over DoT/DoH
// and hand the script a direct seed list.
let direct = uri;
const m = uri.match(/^mongodb\+srv:\/\/([^@]+)@([^/?]+)\/([^?]*)\??(.*)$/);
if (m) {
  const [, creds, host, db, opts] = m;
  const res = await fetch(`https://dns.google/resolve?name=_mongodb._tcp.${host}&type=SRV`);
  const json = await res.json();
  const parts = (json.Answer || [])
    .map((a) => a.data.trim().split(/\s+/))
    .filter((p) => p.length === 4);
  if (!parts.length) { console.error('SRV resolution failed'); process.exit(1); }
  const hosts = parts.map((p) => `${p[3].replace(/\.$/, '')}:${p[2]}`).join(',');
  // SRV implies TLS; a plain mongodb:// seed list does not, and Atlas rejects
  // the unencrypted handshake.
  const withTls = /(^|&)tls=/.test(opts) ? opts : `${opts}${opts ? '&' : ''}tls=true`;
  direct = `mongodb://${creds}@${hosts}/${db}${withTls ? `?${withTls}` : ''}`;
  console.log(`resolved ${parts.length} atlas hosts`);
}

const res = spawnSync(process.execPath, ['scripts/provisionAdmin.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MONGODB_URI: direct,
    ADMIN_EMAIL: EMAIL,
    ADMIN_PASSWORD: PASSWORD,
    ADMIN_SECRET: `reset-${Date.now()}`,
  },
  stdio: 'inherit',
});
if (res.status !== 0) { console.error('provisioning failed'); process.exit(res.status ?? 1); }

await mongoose.connect(direct);
const { default: User } = await import('./models/User.js');
const { default: Session } = await import('./models/Session.js');

const user = await User.findOne({ email: EMAIL }).lean();
if (!user) { console.error('user vanished'); process.exit(1); }

const revoked = await Session.updateMany({ userId: user._id, revoked: { $ne: true } }, { $set: { revoked: true } });
console.log(JSON.stringify({
  email: user.email,
  role: user.role,
  status: user.status,
  sessionsRevoked: revoked.modifiedCount,
}));
await mongoose.disconnect();
