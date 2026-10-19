import nodemailer from 'nodemailer';

export function accountMail(env = process.env) {
  const available = !!(env.SMTP_HOST && env.MAIL_FROM);
  const transport = available ? nodemailer.createTransport({
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true',
    requireTLS: env.SMTP_SECURE !== 'true',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD || '' } : undefined,
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
  }) : null;
  async function send(to, kind, token) {
    if (!transport) throw new Error('mail-unavailable');
    const base = new URL(env.PUBLIC_BASE_URL || env.ORIGIN || 'http://localhost:8080');
    base.search = ''; base.hash = ''; base.pathname = base.pathname.replace(/\/?$/, '/');
    const link = base.href + '#/admin?' + new URLSearchParams({ action: kind, token });
    const result = await transport.sendMail({ from: env.MAIL_FROM, to,
      subject: kind === 'verify' ? 'Kuch: verify your login email' : 'Kuch: reset your password',
      text: `${kind === 'verify' ? 'Verify your login email within 24 hours.' : 'Reset your password within 30 minutes.'}\n${link}\nIf you did not request this, ignore this message.`,
    });
    if (!result.accepted?.length) throw new Error('mail-failed');
  }
  return { available, send };
}
