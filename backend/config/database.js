import mongoose from 'mongoose';
import env from './env.js';
import { logger } from '../utils/logger.js';
let connected = false;
let retryTimer = null;

// Fail a request fast rather than letting Mongoose buffer for the default 10s.
// A 10s hang is longer than the browser/UI timeout and surfaces to users as a
// false "backend unreachable".
mongoose.set('bufferTimeoutMS', 8000);

const MONGO_OPTIONS = {
  dbName: 'sololevelingtrad',
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
  // Force IPv4. Railway's egress and some DNS setups cannot use the IPv6
  // address an Atlas `mongodb+srv://` record may resolve to, which shows up as
  // a "backend unreachable" boot failure only in the cloud, never locally.
  family: 4,
};

function attachListeners() {
  const c = mongoose.connection;
  if (c.__sltListeners) return;
  c.__sltListeners = true;
  c.on('disconnected', () => { connected = false; logger.warn('MongoDB disconnected — driver will reconnect'); });
  c.on('reconnected', () => { connected = true; logger.info('MongoDB reconnected'); });
  c.on('error', (e) => logger.error('MongoDB connection error: ' + e.message));
}

async function tryConnect() {
  await mongoose.connect(env.MONGODB_URI, MONGO_OPTIONS);
  connected = true;
  attachListeners();
}

// After the initial burst fails we keep retrying in the background with backoff.
// Previously the process gave up permanently on the first boot failure, leaving
// every request hanging/erroring until a manual redeploy.
function scheduleReconnect(delayMs = 15000) {
  if (retryTimer) return;
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    if (mongoose.connection.readyState === 1) return;
    try {
      await tryConnect();
      logger.info('MongoDB connected (background retry): sololevelingtrad');
    } catch (e) {
      logger.warn(`Mongo reconnect failed: ${e.message}`);
      scheduleReconnect(Math.min(delayMs * 2, 60000));
    }
  }, delayMs);
  retryTimer.unref?.();
}

export async function connectDB(retries = 5) {
  if (!env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  mongoose.set('strictQuery', true);
  for (let i = 1; i <= retries; i++) {
    try {
      await tryConnect();
      logger.info('MongoDB connected: sololevelingtrad');
      return mongoose.connection;
    } catch (e) {
      logger.error(`Mongo connect attempt ${i}/${retries} failed: ${e.message}`);
      if (i === retries) { scheduleReconnect(); throw e; }
      await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
}
export const dbState = () => ({ connected, state: mongoose.connection.readyState });
export function gracefulShutdown(server) {
  let closing = false;
  const shut = async (sig) => {
    if (closing) return;
    closing = true;
    logger.info(`${sig} received — shutting down`);
    // Never let a stuck connection keep the container alive past Railway's
    // SIGKILL grace period.
    const force = setTimeout(() => process.exit(0), 10000);
    force.unref?.();
    try {
      const closed = new Promise((resolve) => server?.close(resolve));
      // Release keep-alive sockets so close() can actually complete.
      server?.closeIdleConnections?.();
      await closed;
      await mongoose.disconnect();
    } catch (e) { logger.warn('Shutdown error: ' + e.message); }
    process.exit(0);
  };
  process.on('SIGINT', () => shut('SIGINT'));
  process.on('SIGTERM', () => shut('SIGTERM'));
}
