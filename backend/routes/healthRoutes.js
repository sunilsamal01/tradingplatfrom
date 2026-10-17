import { Router } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';

// ---------------------------------------------------------------------------
// Health & readiness probes.
//
// Mounted at /api BEFORE the general rate limiter on purpose: a 429 on a probe
// is indistinguishable from an outage. Railway's healthcheck and the client's
// isBackendUp() poll both treat any non-2xx as "backend unreachable", so these
// endpoints must never be throttled.
// ---------------------------------------------------------------------------
const r = Router();

// Liveness: process is up and serving. Cheap, never touches dependencies, so
// a DB blip can't make an orchestrator restart a healthy process.
r.get('/health', (req, res) => res.json({
  success: true,
  message: 'OK',
  data: { db: mongoose.connection.readyState === 1 ? 'up' : 'down', time: new Date().toISOString() },
}));

r.get('/health/live', (_req, res) => res.json({
  success: true,
  message: 'OK',
  data: { status: 'live', uptimeSec: Math.round(process.uptime()), time: new Date().toISOString() },
}));

// Readiness: dependencies are actually usable. Returns 503 when the database
// is not connected so traffic is not routed to an instance that cannot serve.
r.get('/health/ready', asyncHandler(async (req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  let ping = false;
  if (dbUp) { try { await mongoose.connection.db.admin().command({ ping: 1 }); ping = true; } catch { ping = false; } }
  const ready = dbUp && ping;
  return res.status(ready ? 200 : 503).json({
    success: ready,
    message: ready ? 'READY' : 'NOT_READY',
    data: { status: ready ? 'ready' : 'not_ready', db: dbUp ? 'up' : 'down', dbPing: ping, time: new Date().toISOString() },
  });
}));

export default r;
