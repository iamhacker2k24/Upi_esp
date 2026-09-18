// ==============================================================================
// imapService.js - Gmail IMAP Email Retrieval Service
// ==============================================================================
// This file handles:
// 1. Authenticating to Google's IMAP server using a 16-character Google App Password.
// 2. Opening the user's INBOX securely using TLS on port 993.
// 3. Searching for emails received from a specific sender address.
// 4. Parsing the raw email MIME data stream using mailparser.
// 5. Returning only the message text body and timing (timestamp).
// ==============================================================================

import { ImapFlow } from 'imapflow';       // Modern, promise-based IMAP client for Node.js
import { simpleParser } from 'mailparser'; // Parses raw RFC822 MIME emails into text, HTML, etc.

/**
 * Creates and configures an ImapFlow connection client for Gmail.
 *
 * @param {string} emailUser - Your Gmail address (e.g. "mr.debabrtapc2006@gmail.com")
 * @param {string} appPassword - 16-character App Password generated after enabling Google 2FA
 * @returns {ImapFlow} An authenticated ImapFlow client ready to connect
 */
export function createImapClient(emailUser, appPassword) {
  // Step 1: Validate that both username and password are provided
  if (!emailUser || !appPassword) {
    throw new Error('Missing EMAIL_USER or EMAIL_APP_PASSWORD. Please check your .env file.');
  }

  // Step 2: Clean the App Password.
  // Google displays 16-digit passwords with spaces (e.g. "gytf ctye jqcb eizg").
  // We remove all spaces so it becomes continuous 16 characters ("gytfctyejqcbeizg").
  const cleanPassword = String(appPassword).replace(/\s+/g, '').trim();

  // Step 3: Initialize the ImapFlow client with Google IMAP server settings
  const client = new ImapFlow({
    host: 'imap.gmail.com', // Official Gmail IMAP host
    port: 993,              // Port 993 is standard for secure IMAP over SSL/TLS
    secure: true,           // Enforce TLS encryption for full security
    auth: {
      user: emailUser.trim(), // Gmail account username
      pass: cleanPassword,    // Cleaned 16-digit Google App Password
    },
    logger: false,          // Suppress raw IMAP protocol logging for clean console output
    emitLogs: false,
  });

  // Step 4: Handle background network socket reset events (e.g. ECONNRESET on logout)
  // This prevents unhandled socket disconnect errors from crashing the Node.js process
  client.on('error', (err) => {
    if (err.code === 'ECONNRESET') {
      return; // Ignore normal socket teardown after logout
    }
    console.error('IMAP background error:', err.message);
  });

  return client;
}

/**
 * Parses raw email source stream into text, date, and other details.
 *
 * @param {Buffer|string} source - Raw email MIME stream from IMAP server
 * @param {object} meta - Additional message metadata (uid, flags, seq, internalDate)
 * @returns {Promise<object>} Structured parsed email object
 */
async function parseEmailMessage(source, meta = {}) {
  // Use mailparser to convert raw MIME buffer into structured JavaScript object
  const parsed = await simpleParser(source);

  // Extract text body, falling back to subject if body is empty
  const messageBody = parsed.text ? parsed.text.trim() : (parsed.subject || '');

  // Extract timing/timestamp as ISO format string
  const messageTiming = parsed.date
    ? parsed.date.toISOString()
    : (meta.internalDate ? new Date(meta.internalDate).toISOString() : new Date().toISOString());

  return {
    message: messageBody,
    timing: messageTiming,
    // Detailed fields (available if needed):
    uid: meta.uid || null,
    subject: parsed.subject || '(No Subject)',
    from: parsed.from?.value?.[0]?.address || parsed.from?.text || null,
    to: (parsed.to?.value || []).map((r) => r.address),
  };
}

/**
 * Searches the Gmail mailbox for emails from a specific sender.
 *
 * @param {object} options
 * @param {string} options.emailUser - Gmail address
 * @param {string} options.appPassword - 16-character App Password
 * @param {string} options.sender - Sender address to filter by (e.g. "mr.debabratapaul2006@gmail.com")
 * @param {number} [options.limit=1] - Maximum number of recent emails to return
 * @param {boolean} [options.unreadOnly=false] - If true, only search unread emails
 * @param {string} [options.mailbox='INBOX'] - Mailbox folder (defaults to 'INBOX')
 * @returns {Promise<{success: boolean, count: number, emails: Array}>}
 */
export async function fetchEmailsFromSender({
  emailUser,
  appPassword,
  sender,
  limit = 1,
  unreadOnly = false,
  mailbox = 'INBOX',
}) {
  // Step 1: Instantiate IMAP client with sanitized credentials
  const client = createImapClient(emailUser, appPassword);
  const emails = [];

  try {
    // Step 2: Establish TLS connection to imap.gmail.com
    await client.connect();

    // Step 3: Lock and open the INBOX mailbox for reading
    const lock = await client.getMailboxLock(mailbox);

    try {
      // Step 4: Build search query criteria
      const searchQuery = {};
      if (sender && sender.trim()) {
        searchQuery.from = sender.trim();
      }
      if (unreadOnly) {
        searchQuery.seen = false; // Only fetch unseen/unread messages
      }

      // Step 5: Execute search on Gmail IMAP to get matching email UIDs
      let uids = await client.search(searchQuery, { uid: true });

      // Step 6: Smart typo tolerance.
      // If user typed ".ocm" instead of ".com", auto-retry search with ".com"
      if ((!uids || uids.length === 0) && sender && sender.toLowerCase().includes('.ocm')) {
        const correctedSender = sender.replace(/\.ocm/gi, '.com');
        const retrySearch = { ...searchQuery, from: correctedSender.trim() };
        const retryUids = await client.search(retrySearch, { uid: true });
        if (retryUids && retryUids.length > 0) {
          uids = retryUids;
        }
      }

      // If no messages match the sender, return an empty list
      if (!uids || uids.length === 0) {
        return {
          success: true,
          count: 0,
          emails: [],
        };
      }

      // Step 7: Take the latest matching UID(s) based on limit
      // Gmail UIDs are sorted in ascending order, so the last element is the newest email
      const parsedLimit = Math.max(1, parseInt(limit, 10) || 1);
      const targetUids = uids.slice(-parsedLimit).reverse();

      // Step 8: Fetch raw email data for the matching UID(s)
      for await (const message of client.fetch(targetUids, {
        uid: true,
        flags: true,
        internalDate: true,
        source: true, // Fetch the raw message RFC822 stream to parse text and date
      }, { uid: true })) {
        if (message.source) {
          // Step 9: Parse message into clean text and timing
          const emailData = await parseEmailMessage(message.source, {
            uid: message.uid,
            flags: message.flags,
            internalDate: message.internalDate,
          });
          emails.push(emailData);
        }
      }

      return {
        success: true,
        count: emails.length,
        emails,
      };
    } finally {
      // Always release the mailbox lock when done
      lock.release();
    }
  } catch (error) {
    // Provide user-friendly guidance for authentication or permission issues
    let friendlyMessage = error.message;

    if (
      error.message?.includes('AUTHENTICATIONFAILED') ||
      error.message?.includes('Invalid credentials') ||
      error.responseStatus === 'NO'
    ) {
      friendlyMessage =
        'Gmail authentication failed. Please verify that your Google Account has 2-Step Verification enabled and you are using a 16-character App Password (not your normal password).';
    }

    const enhancedError = new Error(friendlyMessage);
    enhancedError.statusCode = error.message?.includes('AUTHENTICATIONFAILED') ? 401 : 500;
    throw enhancedError;
  } finally {
    // Gracefully logout from the IMAP session to free server resources
    try {
      await client.logout();
    } catch {
      // Ignore disconnect cleanup errors
    }
  }
}

/**
 * Fetches only the single latest email from sender and returns ONLY { message, timing }.
 *
 * @param {object} options
 * @param {string} options.emailUser - Gmail account email
 * @param {string} options.appPassword - 16-character App Password
 * @param {string} options.sender - Sender email address
 * @returns {Promise<{message: string, timing: string}|null>} The message and timing only
 */
export async function fetchLatestEmail(options) {
  // Query with limit 1 to retrieve only the most recent email
  const result = await fetchEmailsFromSender({
    ...options,
    limit: 1,
  });

  // If no email was found, return null
  if (!result.emails || result.emails.length === 0) {
    return null;
  }

  // Return strictly message and timing
  const email = result.emails[0];
  return {
    message: email.message,
    timing: email.timing,
  };
}

/**
 * Tests IMAP connection status and credentials validity.
 *
 * @param {string} emailUser - Gmail address
 * @param {string} appPassword - 16-character App Password
 * @returns {Promise<object>} Status report showing total and unseen message counts
 */
export async function testConnection(emailUser, appPassword) {
  const client = createImapClient(emailUser, appPassword);
  try {
    await client.connect();
    const status = await client.status('INBOX', { messages: true, unseen: true });
    return {
      connected: true,
      inbox: {
        totalMessages: status.messages,
        unseenMessages: status.unseen,
      },
    };
  } finally {
    try {
      await client.logout();
    } catch {
      // Ignore cleanup error
    }
  }
}
