// ==============================================================================
// mailWatcher.js - Continuous 1-Second Gmail Inbox Watcher (Without WebSockets)
// ==============================================================================
// 1. Keeps a persistent IMAP connection open to Gmail.
// 2. Uses client.noop() every 1 second to force Gmail to sync untagged EXISTS updates.
// 3. Immediately detects any new email from TARGET_SENDER.
// 4. Extracts ONLY { "message": "...", "timing": "..." }.
// 5. Logs the JSON directly to the console AND pushes it to SSE clients (/api/emails/stream).
// ==============================================================================

import { EventEmitter } from 'events';
import { createImapClient } from './imapService.js';
import { simpleParser } from 'mailparser';

export const emailEvents = new EventEmitter();
emailEvents.setMaxListeners(100);

let lastKnownUid = null;
let currentLatestEmail = null;
let isWatching = false;

/**
 * Returns the most recently fetched email stored in memory.
 */
export function getCachedLatestEmail() {
  return currentLatestEmail;
}

/**
 * Parses raw email source into strictly { message, timing }.
 */
async function parseMessageAndTiming(source, meta = {}) {
  const parsed = await simpleParser(source);
  return {
    message: parsed.text ? parsed.text.trim() : (parsed.subject || ''),
    timing: parsed.date ? parsed.date.toISOString() : (meta.internalDate ? new Date(meta.internalDate).toISOString() : new Date().toISOString()),
  };
}

/**
 * Checks for new emails and emits them if UID is newer than lastKnownUid.
 */
async function checkForNewEmails(client, sender) {
  const lock = await client.getMailboxLock('INBOX');
  try {
    // Send NOOP to force Gmail IMAP to emit untagged EXISTS for newly arrived emails
    await client.noop();

    // Build search query (if sender is '*' or empty, match all)
    const isWildcard = !sender || sender === '*' || sender.toLowerCase() === 'any';
    const searchQuery = isWildcard ? { all: true } : { from: sender.trim() };

    let uids = await client.search(searchQuery, { uid: true });

    // Auto-correct .ocm typo if needed
    if ((!uids || uids.length === 0) && sender && sender.toLowerCase().includes('.ocm')) {
      const corrected = sender.replace(/\.ocm/gi, '.com');
      uids = await client.search({ from: corrected.trim() }, { uid: true });
    }

    if (uids && uids.length > 0) {
      const latestUid = uids[uids.length - 1];

      // If this is the first run OR a newer UID arrived:
      if (lastKnownUid === null || latestUid > lastKnownUid) {
        const isFirstCheck = (lastKnownUid === null);
        lastKnownUid = latestUid;

        // Fetch the raw source of the newest email
        const msg = await client.fetchOne(latestUid, {
          source: true,
          internalDate: true,
          uid: true,
        }, { uid: true });

        if (msg && msg.source) {
          currentLatestEmail = await parseMessageAndTiming(msg.source, {
            internalDate: msg.internalDate,
          });

          if (!isFirstCheck) {
            console.log('\n📬 [NEW EMAIL DETECTED]');
            console.log(JSON.stringify(currentLatestEmail, null, 2));
          } else {
            console.log(`📬 [Watcher Ready] Loaded latest email (UID: ${latestUid})`);
          }

          // Emit to all Server-Sent Events (SSE) connected clients
          emailEvents.emit('new-email', currentLatestEmail);
        }
      }
    }
  } finally {
    lock.release();
  }
}

/**
 * Starts continuous mailbox monitoring checking every 1 second.
 *
 * @param {object} config
 * @param {string} config.emailUser - Gmail account address
 * @param {string} config.appPassword - 16-character App Password
 * @param {string} config.sender - Sender email to monitor
 * @param {number} [config.intervalMs=1000] - Polling interval (default: 1000ms = 1s)
 */
export async function startMailWatcher({ emailUser, appPassword, sender, intervalMs = 1000 }) {
  if (isWatching) return;
  isWatching = true;

  console.log(`📡 [Watcher] Starting 1s continuous check for sender: "${sender}"...`);

  async function runWatcherLoop() {
    let client = null;

    while (isWatching) {
      try {
        client = createImapClient(emailUser, appPassword);
        await client.connect();
        console.log(`🟢 [Watcher] Connected to Gmail IMAP. Checking every ${intervalMs / 1000}s...`);

        // Listen for real-time IMAP server 'exists' push notifications
        client.on('exists', () => {
          checkForNewEmails(client, sender).catch(() => {});
        });

        // Continuous 1-second checking loop
        while (isWatching && client.usable) {
          await checkForNewEmails(client, sender);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      } catch (err) {
        console.error(`⚠️ [Watcher] Connection error: ${err.message}. Reconnecting in 2s...`);
        try {
          if (client) await client.logout();
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  // Launch background loop
  runWatcherLoop().catch((err) => {
    console.error('Watcher loop error:', err);
    isWatching = false;
  });
}
