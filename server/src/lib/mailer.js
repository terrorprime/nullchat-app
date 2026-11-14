import { config } from '../config.js';

let transporter = null;
let transporterTried = false;

async function getTransporter() {
  if (transporterTried) return transporter;
  transporterTried = true;
  if (!config.smtp.host) return null;
  try {
    const nodemailer = (await import('nodemailer')).default;
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
    await transporter.verify();
    console.log(`[mail] SMTP ready (${config.smtp.host}:${config.smtp.port})`);
  } catch (e) {
    console.error('[mail] SMTP is configured but not usable — falling back to console output:', e.message);
    transporter = null;
  }
  return transporter;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function layout(title, body, buttonText, buttonUrl) {
  return `<!doctype html><html><body style="margin:0;background:#040405;font-family:Segoe UI,Arial,sans-serif;color:#e6e8ee">
  <div style="max-width:520px;margin:32px auto;background:#0d0e11;border:1px solid #23262d;border-radius:16px;padding:32px">
    <div style="font-size:22px;font-weight:800;color:#c2ff3d;margin-bottom:16px;letter-spacing:-.03em">NullChat</div>
    <h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>
    <p style="line-height:1.5;color:#b8bcc8">${body}</p>
    <p style="margin:28px 0"><a href="${escapeHtml(buttonUrl)}" style="background:#c2ff3d;color:#0b0d05;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${escapeHtml(buttonText)}</a></p>
    <p style="font-size:12px;color:#7d8394">If the button does not work, paste this link into your browser:<br>${escapeHtml(buttonUrl)}</p>
  </div></body></html>`;
}

export const devOutbox = []; // last few emails, visible in development only

export async function sendMail({ to, subject, text, html }) {
  const t = await getTransporter();
  if (!t) {
    devOutbox.unshift({ to, subject, text, sentAt: Date.now() });
    devOutbox.length = Math.min(devOutbox.length, 20);
    console.log('\n──────── 📧 NullChat email (no SMTP configured — printed instead) ────────');
    console.log(`To: ${to}\nSubject: ${subject}\n\n${text}`);
    console.log('────────────────────────────────────────────────────────────────────────\n');
    return;
  }
  await t.sendMail({ from: config.smtp.from, to, subject, text, html });
}

export function sendPasswordResetEmail(user, token) {
  const url = `${config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
  return sendMail({
    to: user.email,
    subject: 'Reset your NullChat password',
    text: `Hi ${user.username},\n\nSomeone (hopefully you) asked to reset your NullChat password. Open this link to choose a new one:\n${url}\n\nThe link expires in 1 hour. If you did not ask for this, you can ignore this email.`,
    html: layout('Reset your password', `Hi ${escapeHtml(user.username)}, someone (hopefully you) asked to reset your password. The link expires in 1 hour. If this wasn't you, ignore this email.`, 'Reset Password', url),
  });
}
