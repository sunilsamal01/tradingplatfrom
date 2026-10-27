// Read-only diagnostic: which database does backend/.env actually point at, and
// is it the one serving the live site?
import dotenv from 'dotenv';
import mongoose from 'mongoose';
dotenv.config();

const uri = process.env.MONGODB_URI;
const m = uri.match(/^mongodb\+srv:\/\/([^@]+)@([^/?]+)\/([^?]*)\??(.*)$/);
let direct = uri;
if (m) {
  const [, creds, host, db, opts] = m;
  const json = await (await fetch(`https://dns.google/resolve?name=_mongodb._tcp.${host}&type=SRV`)).json();
  const hosts = json.Answer.map((a) => a.data.trim().split(/\s+/))
    .map((p) => `${p[3].replace(/\.$/, '')}:${p[2]}`).join(',');
  const withTls = /(^|&)tls=/.test(opts) ? opts : `${opts}${opts ? '&' : ''}tls=true`;
  direct = `mongodb://${creds}@${hosts}/${db}${withTls ? `?${withTls}` : ''}`;
}
await mongoose.connect(direct);
const db = mongoose.connection.db;
const cols = (await db.listCollections().toArray()).map((c) => c.name).sort();

const users = await db.collection('users').countDocuments();
const sessions = cols.includes('sessions') ? await db.collection('sessions').countDocuments() : null;
const admin = await db.collection('users').findOne(
  { email: 'hello@sololevelingtrad.online' },
  { projection: { email: 1, role: 1, passwordHash: 1, updatedAt: 1, createdAt: 1 } },
);
const buyer = await db.collection('users').findOne({ email: 'amendabeiberdmj@outlook.com' }, { projection: { email: 1, createdAt: 1 } });
const orders = cols.includes('checkoutorders') ? await db.collection('checkoutorders').countDocuments() : null;
const payments = cols.includes('payments') ? await db.collection('payments').countDocuments() : null;

console.log(JSON.stringify({
  databaseName: db.databaseName,
  collections: cols.length,
  users, sessions, orders, payments,
  admin: admin && { role: admin.role, hashPrefix: admin.passwordHash?.slice(0, 7), updatedAt: admin.updatedAt, createdAt: admin.createdAt },
  buyerFound: !!buyer,
}, null, 2));
await mongoose.disconnect();
