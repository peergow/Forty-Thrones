import nodemailer from 'nodemailer';
import { config } from './config.js';

let transport = null;
if (config.smtp.host) {
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

/** The ONLY message ever sent to a previous owner. Neutral: no call to action, no "take it back" link. */
export async function notifyThroneTaken(email, username, tileName) {
  const subject = 'Your Forty Thrones tile has changed hands';
  const text = `Hi ${username || 'there'},\n\nYour tile "${tileName}" has been taken over by another player. Your name and payment remain in the permanent history of that tile.\n\nForty Thrones`;
  try {
    if (!transport) { console.log(`[notify] to=${email} subject="${subject}" tile="${tileName}"`); return; }
    await transport.sendMail({ from: config.smtp.from, to: email, subject, text });
  } catch (err) {
    console.error('[notify] failed:', err.message);
  }
}
