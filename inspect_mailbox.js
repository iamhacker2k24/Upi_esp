import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createImapClient } from './src/imapService.js';
import { simpleParser } from 'mailparser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

async function inspect() {
  console.log('Connecting to Gmail...');
  const client = createImapClient(process.env.EMAIL_USER, process.env.EMAIL_APP_PASSWORD);
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    console.log('--- INBOX STATUS ---');
    console.log('Total messages in INBOX:', client.mailbox.exists);
    console.log('Current TARGET_SENDER:', process.env.TARGET_SENDER);

    const count = 6;
    const exists = client.mailbox.exists;
    const start = Math.max(1, exists - count + 1);
    const range = `${start}:*`;

    console.log(`\n--- FETCHING LATEST ${count} EMAILS IN INBOX ---`);
    for await (const msg of client.fetch(range, { uid: true, internalDate: true, source: true })) {
      const parsed = await simpleParser(msg.source);
      console.log('==============================================');
      console.log('UID:', msg.uid);
      console.log('Internal Date:', msg.internalDate);
      console.log('From Address:', parsed.from?.value?.[0]?.address);
      console.log('From Name:', parsed.from?.value?.[0]?.name);
      console.log('From Raw Header:', parsed.from?.text);
      console.log('Subject:', parsed.subject);
      console.log('Message snippet:', (parsed.text || '').slice(0, 100).replace(/\n/g, ' '));
    }
  } finally {
    lock.release();
    await client.logout();
  }
}

inspect().catch(console.error);
