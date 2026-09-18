// ==============================================================================
// server.js - Express HTTP Backend with Continuous 1s Real-Time Email Streaming
// ==============================================================================
// Features:
// 1. Continuous 1-second background mailbox checking (IMAP).
// 2. Real-time streaming via Server-Sent Events (SSE) at GET /api/emails/stream:
//    Pushes new emails as JSON immediately to clients without refreshing or polling.
// 3. Instant REST endpoint at GET /api/emails:
//    Returns ONLY the latest { "message": "...", "timing": "..." } as clean JSON.
// 4. Live interactive web dashboard at GET / to watch new emails arrive in real-time.
// ==============================================================================

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchLatestEmail } from './imapService.js';
import { startMailWatcher, emailEvents, getCachedLatestEmail } from './mailWatcher.js';

// ------------------------------------------------------------------------------
// Step 1: Load Environment Variables (.env)
// ------------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ------------------------------------------------------------------------------
// Step 2: Real-Time Streaming Endpoint (Server-Sent Events / SSE)
// ------------------------------------------------------------------------------
// GET /api/emails/stream
// Connect via browser native EventSource or curl. No WebSockets needed!
// Whenever a new email arrives from TARGET_SENDER, it automatically pushes:
// data: {"message": "...", "timing": "..."}
app.get('/api/emails/stream', (req, res) => {
  // Set SSE response headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // 1. Immediately send the current latest email upon connection
  const cached = getCachedLatestEmail();
  if (cached) {
    res.write(`data: ${JSON.stringify(cached)}\n\n`);
  }

  // 2. Stream new incoming emails detected by the 1-second watcher
  const handleNewEmail = (email) => {
    res.write(`data: ${JSON.stringify({ message: email.message, timing: email.timing })}\n\n`);
  };

  emailEvents.on('new-email', handleNewEmail);

  // 3. Heartbeat ping every 15s to keep the HTTP connection active
  const keepAliveTimer = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000);

  // 4. Clean up listeners when the client disconnects
  req.on('close', () => {
    clearInterval(keepAliveTimer);
    emailEvents.off('new-email', handleNewEmail);
  });
});

// ------------------------------------------------------------------------------
// Step 3: Standard Instant JSON REST Route
// ------------------------------------------------------------------------------
// GET /api/emails (also responds on /api/emails/latest and /api/email)
// Returns strictly:
// {
//   "message": "...",
//   "timing": "..."
// }
app.get(['/api/email', '/api/emails', '/api/emails/latest'], async (req, res, next) => {
  try {
    const emailUser = process.env.EMAIL_USER;
    const appPassword = process.env.EMAIL_APP_PASSWORD;
    const sender = req.query.sender !== undefined ? req.query.sender : (process.env.TARGET_SENDER || 'dev@gmail.ocm');

    // 1. Check if we already have the latest email cached in memory from the 1s watcher
    const cached = getCachedLatestEmail();
    if (cached && (!req.query.sender || req.query.sender === process.env.TARGET_SENDER)) {
      return res.json(cached);
    }

    // 2. Fallback: Fetch directly from IMAP
    const data = await fetchLatestEmail({
      emailUser,
      appPassword,
      sender,
    });

    if (!data) {
      return res.status(404).json({ message: '', timing: '' });
    }

    res.json(data);
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------------------------------
// Step 4: Health Route
// ------------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: 'continuous-1s-watcher-active',
    monitoredSender: process.env.TARGET_SENDER || 'dev@gmail.ocm',
    cachedLatestTiming: getCachedLatestEmail()?.timing || null,
  });
});

// ------------------------------------------------------------------------------
// Step 5: Live Real-Time Web Monitor (Interactive UI without WebSockets)
// ------------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live Mail Monitor (Real-Time 1s)</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0f172a; color: #f8fafc; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 2rem; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; width: 100%; max-width: 700px; padding: 1.5rem; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem; border-bottom: 1px solid #334155; padding-bottom: 1rem; }
    .title { font-size: 1.25rem; font-weight: 700; color: #38bdf8; }
    .badge { background: #064e3b; color: #34d399; font-size: 0.8rem; font-weight: 600; padding: 0.35rem 0.75rem; border-radius: 9999px; display: inline-flex; align-items: center; gap: 6px; }
    .dot { width: 8px; height: 8px; background: #34d399; border-radius: 50%; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.8); } }
    .meta { font-size: 0.85rem; color: #94a3b8; margin-bottom: 1rem; }
    .box-title { font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 0.5rem; }
    .json-box { background: #020617; border: 1px solid #1e293b; border-radius: 8px; padding: 1rem; color: #38bdf8; font-family: monospace; font-size: 0.95rem; white-space: pre-wrap; word-break: break-word; min-height: 180px; }
    .endpoints { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid #334155; font-size: 0.85rem; color: #94a3b8; }
    .endpoints a { color: #38bdf8; text-decoration: none; }
    .endpoints a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="title">📬 Live Mail Stream (Real-Time)</div>
      <div class="badge"><span class="dot"></span> 1s Checking Active</div>
    </div>
    <div class="meta">
      Monitoring Sender: <strong>${process.env.TARGET_SENDER || 'dev@gmail.ocm'}</strong><br>
      Streaming Method: <strong>Server-Sent Events (SSE - No WebSockets, No Refresh)</strong>
    </div>

    <div class="box-title">Live JSON Output (Auto-updates instantaneously):</div>
    <pre id="jsonDisplay" class="json-box">Connecting to live 1-second stream...</pre>

    <div class="endpoints">
      <strong>Endpoints:</strong><br>
      • Raw Real-Time Stream: <a href="/api/emails/stream" target="_blank">/api/emails/stream</a><br>
      • Instant JSON: <a href="/api/emails" target="_blank">/api/emails</a>
    </div>
  </div>

  <script>
    const display = document.getElementById('jsonDisplay');

    // Built-in browser Server-Sent Events (SSE) - Zero WebSockets, Zero Refresh!
    const evtSource = new EventSource('/api/emails/stream');

    evtSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        display.textContent = JSON.stringify(data, null, 2);
        display.style.borderColor = '#38bdf8';
        setTimeout(() => { display.style.borderColor = '#1e293b'; }, 600);
      } catch (err) {
        display.textContent = event.data;
      }
    };

    evtSource.onerror = () => {
      display.textContent = 'Reconnecting to live email stream...';
    };
  </script>
</body>
</html>`);
});

// Centralized error handling
app.use((err, req, res, next) => {
  res.status(err.statusCode || 500).json({
    error: err.message || 'Internal Server Error',
  });
});

// ------------------------------------------------------------------------------
// Step 6: Start Server & Launch Background 1s Watcher
// ------------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Continuous Email Reader Backend running on port ${PORT}`);
  console.log(`📡 Live Stream (SSE): http://localhost:${PORT}/api/emails/stream`);
  console.log(`📡 Instant JSON API:  http://localhost:${PORT}/api/emails`);
  console.log(`🖥️  Live Dashboard:    http://localhost:${PORT}/`);
  console.log(`📬 Monitoring sender: ${process.env.TARGET_SENDER || 'dev@gmail.ocm'}`);
  console.log(`⏱️  Check frequency:  Every 1 second`);
  console.log(`====================================================`);

  // Launch continuous 1-second background watcher if credentials exist
  if (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD) {
    startMailWatcher({
      emailUser: process.env.EMAIL_USER,
      appPassword: process.env.EMAIL_APP_PASSWORD,
      sender: process.env.TARGET_SENDER,
      intervalMs: 1000, // Check every 1000ms (1s)
    });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is in use. Please change PORT in your .env (e.g. PORT=5001).`);
  } else {
    console.error('❌ Server startup error:', err);
  }
});

export default app;
