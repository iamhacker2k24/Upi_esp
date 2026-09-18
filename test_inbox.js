// ==============================================================================
// test_inbox.js - Standalone CLI Email Tester & Live Watcher Script
// ==============================================================================
// Usage:
// 1. Single snapshot check:
//    npm run check-mail
// 2. Continuous 1-second watcher (prints JSON live whenever an email arrives):
//    npm run watch-mail
// ==============================================================================

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchLatestEmail } from './src/imapService.js';
import { startMailWatcher, emailEvents } from './src/mailWatcher.js';

// Load environment variables from the project root .env file
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const isWatchMode = process.argv.includes('--watch') || process.argv.includes('-w');

async function runOnce() {
  try {
    const data = await fetchLatestEmail({
      emailUser: process.env.EMAIL_USER,
      appPassword: process.env.EMAIL_APP_PASSWORD,
      sender: process.env.TARGET_SENDER,
    });

    if (!data) {
      console.log(JSON.stringify({ message: '', timing: '' }, null, 2));
      return;
    }

    console.log(JSON.stringify({
      message: data.message,
      timing: data.timing,
    }, null, 2));

  } catch (error) {
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exit(1);
  }
}

async function runWatch() {
  console.log(`📡 Starting continuous 1s terminal watcher for: ${process.env.TARGET_SENDER}`);
  console.log(`Waiting for new emails... (Press Ctrl+C to stop)\n`);

  // Listen for real-time detected emails
  emailEvents.on('new-email', (data) => {
    console.log(JSON.stringify({
      message: data.message,
      timing: data.timing,
    }, null, 2));
  });

  // Start the background 1-second watcher
  startMailWatcher({
    emailUser: process.env.EMAIL_USER,
    appPassword: process.env.EMAIL_APP_PASSWORD,
    sender: process.env.TARGET_SENDER,
    intervalMs: 1000,
  });
}

if (isWatchMode) {
  runWatch();
} else {
  runOnce();
}
