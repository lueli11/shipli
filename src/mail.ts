import { createTransport } from 'nodemailer';

// SHIPLI_SMTP_URL z. B. smtps://user:passwort@mail.example.com:465
export const mailReady = () => !!process.env.SHIPLI_SMTP_URL;

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const url = process.env.SHIPLI_SMTP_URL;
  if (!url) throw new Error('Shipli kann keine Mails verschicken (SHIPLI_SMTP_URL fehlt)');
  const from = process.env.SHIPLI_MAIL_FROM ?? `Shipli <noreply@${new URL(url).hostname}>`;
  await createTransport(url).sendMail({ from, to, subject, text });
}
