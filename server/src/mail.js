const nodemailer = require('nodemailer');

// Lazily-created transport. If SMTP_* env vars are set we use real SMTP;
// otherwise we spin up an Ethereal test account (emails are NOT delivered,
// but each send returns a preview URL we log).
let transportP = null;
let usingEthereal = false;

async function getTransport() {
  if (transportP) return transportP;
  if (process.env.SMTP_HOST) {
    transportP = Promise.resolve(
      nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      })
    );
    console.log('[mail] using SMTP host', process.env.SMTP_HOST);
  } else {
    usingEthereal = true;
    transportP = nodemailer.createTestAccount().then((acct) => {
      console.log('[mail] no SMTP configured — using Ethereal TEST mode (emails are not actually delivered).');
      console.log('[mail] test inbox login:', acct.user, '/', acct.pass);
      return nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: { user: acct.user, pass: acct.pass },
      });
    });
  }
  return transportP;
}

async function sendMail({ to, subject, text, html }) {
  if (!to) throw new Error('email reminder has no recipient address');
  const transport = await getTransport();
  const info = await transport.sendMail({
    from: process.env.MAIL_FROM || 'Dayflow <no-reply@dayflow.local>',
    to,
    subject,
    text,
    html,
  });
  if (usingEthereal) {
    const url = nodemailer.getTestMessageUrl(info);
    if (url) console.log('[mail] preview (Ethereal):', url);
  }
  return info;
}

module.exports = { sendMail };
