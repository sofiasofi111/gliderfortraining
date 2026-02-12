const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const dns = require('dns').promises;
const SMTPConnection = require('smtp-connection');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Serve static frontend files from project root so phone can load pages via HTTP
app.use(express.static(path.join(__dirname)));

// Configure via environment variables
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_EMAIL = process.env.FROM_EMAIL || SMTP_USER;

const SMTP_CONFIGURED = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
if(!SMTP_CONFIGURED){
  console.warn('Warning: SMTP credentials are not fully set. Server will run in SIMULATION mode (no real emails sent). To enable real sending set SMTP_HOST, SMTP_USER and SMTP_PASS.');
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: Number(SMTP_PORT) === 465, // true for 465, false for other ports
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  }
});

// Rate limiting and retry queue (in-memory)
const sendAttempts = new Map(); // key: email or ip, value: array of timestamps
const FAILED_QUEUE = []; // items: { email, username, code, attempts }

const MAX_ATTEMPTS = 10; // max sends per window (increased for testing)
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RETRY_LIMIT = 3; // retry attempts for failed send

function cleanupAttempts(key) {
  const now = Date.now();
  const arr = sendAttempts.get(key) || [];
  const filtered = arr.filter(t => now - t < WINDOW_MS);
  sendAttempts.set(key, filtered);
  return filtered;
}

function recordAttempt(key) {
  const arr = cleanupAttempts(key);
  arr.push(Date.now());
  sendAttempts.set(key, arr);
}

function canSend(key) {
  const arr = cleanupAttempts(key);
  return arr.length < MAX_ATTEMPTS;
}

async function retrySend(mailOptions) {
  let attempt = 0;
  const delays = [1000, 3000, 7000];
  while (attempt < RETRY_LIMIT) {
    try {
      const info = await transporter.sendMail(mailOptions);
      return { ok: true, info };
    } catch (err) {
      attempt++;
      if (attempt >= RETRY_LIMIT) return { ok: false, err };
      await new Promise(r => setTimeout(r, delays[Math.min(attempt-1, delays.length-1)]));
    }
  }
  return { ok: false };
}

// background worker to retry failed queue
setInterval(async () => {
  if (!SMTP_CONFIGURED) return; // nothing to retry in simulation mode
  if (FAILED_QUEUE.length === 0) return;
  const item = FAILED_QUEUE.shift();
  if (!item) return;
  const { email, username, code, attempts = 0 } = item;
  if (attempts >= RETRY_LIMIT) {
    console.error('Dropping failed send after retries for', email);
    return;
  }
  const mail = {
    from: FROM_EMAIL,
    to: email,
    subject: `Код підтвердження для ${username}`,
    text: `Ваш код підтвердження: ${code}`,
    html: `<p>Привіт, ${username}!</p><p>Ваш код підтвердження: <b>${code}</b></p>`
  };
  try {
    const res = await retrySend(mail);
    if (!res.ok) {
      FAILED_QUEUE.push({ ...item, attempts: attempts + 1 });
    }
  } catch (e) {
    FAILED_QUEUE.push({ ...item, attempts: attempts + 1 });
  }
}, 60 * 1000);

app.get('/health', (req, res) => {
  return res.json({ ok: true, smtpConfigured: SMTP_CONFIGURED });
});

app.post('/send-code', async (req, res) => {
  const { email, username, code } = req.body || {};
  if(!email || !code || !username){
    return res.status(400).json({ ok: false, message: 'Missing email, username or code' });
  }
  // If SMTP is not configured, simulate send: log and return success
  if(!SMTP_CONFIGURED){
    console.log('[SIMULATION] send-code', { email, username, code });
    return res.json({ ok: true, simulated: true });
  }
  // rate limit by email and by IP
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!canSend(email) || !canSend(ip)) {
    return res.status(429).json({ ok: false, message: 'Too many requests. Try later.' });
  }

  recordAttempt(email);
  recordAttempt(ip);

  const mail = {
    from: FROM_EMAIL,
    to: email,
    subject: `Код підтвердження для ${username}`,
    text: `Ваш код підтвердження: ${code}`,
    html: `<p>Привіт, ${username}!</p><p>Ваш код підтвердження: <b>${code}</b></p><p>Якщо це не ви — ігноруйте цей лист.</p>`
  };

  try {
    const result = await retrySend(mail);
    if (result.ok) {
      console.log('Email sent:', result.info && result.info.messageId);
      res.json({ ok: true });
    } else {
      console.error('Send failed, queuing for retry', result.err || 'unknown');
      FAILED_QUEUE.push({ email, username, code, attempts: 0 });
      res.status(202).json({ ok: false, message: 'Queued for retry' });
    }
  } catch (err) {
    console.error('Error sending email', err);
    FAILED_QUEUE.push({ email, username, code, attempts: 0 });
    res.status(202).json({ ok: false, message: 'Queued for retry' });
  }
});

// Check MX records for an email's domain. Returns { ok: true, mx: [...] } when MX found.
app.post('/check-mx', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') return res.status(400).json({ ok: false, message: 'Missing email' });
    const emailTrim = email.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailTrim)) return res.status(400).json({ ok: false, message: 'Invalid email format' });
    const domain = emailTrim.split('@')[1].toLowerCase();
    let mx = [];
    try {
      mx = await dns.resolveMx(domain);
    } catch (err) {
      // DNS lookup failed or no records
      return res.json({ ok: false, mx: [], message: 'MX lookup failed or no MX records', error: String(err && err.message) });
    }
    if (!mx || mx.length === 0) return res.json({ ok: false, mx: [], message: 'No MX records for domain' });
    mx.sort((a, b) => (a.priority || 0) - (b.priority || 0));
    return res.json({ ok: true, mx });
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Internal error', error: String(e && e.message) });
  }
});

// Verify mailbox existence via SMTP RCPT TO.
// Note: some mail servers always accept RCPT (catch-all) or block verification; results are best-effort.
app.post('/verify-email', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') return res.status(400).json({ ok: false, message: 'Missing email' });
    const emailTrim = email.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailTrim)) return res.status(400).json({ ok: false, message: 'Invalid email format' });
    const domain = emailTrim.split('@')[1].toLowerCase();

    // Resolve MX records first
    let mx = [];
    try { mx = await dns.resolveMx(domain); } catch (e) { return res.json({ ok: false, message: 'No MX records', error: String(e && e.message) }); }
    if (!mx || mx.length === 0) return res.json({ ok: false, message: 'No MX records' });

    // sort by priority
    mx.sort((a, b) => (a.priority || 0) - (b.priority || 0));

    // try connecting to MX hosts one by one
    const fromAddress = FROM_EMAIL || 'verify@localhost';
    const timeoutMs = 8000;

    for (const record of mx) {
      const host = record.exchange;
      const conn = new SMTPConnection({ host, port: 25, tls: false, socketTimeout: timeoutMs });
      let listeners = [];
      try {
        // attach error listener early to avoid unhandled exceptions
        const connectPromise = new Promise((resolve, reject) => {
          const onErr = (e) => { reject(e); };
          listeners.push(['error', onErr]);
          conn.once('error', onErr);
          conn.connect(err => { if (err) return reject(err); resolve(); });
        });
        await connectPromise;

        // greet (some servers don't need explicit greet; use available methods defensively)
        try {
          await new Promise((resolve, reject) => conn.greet({ hostname: 'localhost' }, err => err ? reject(err) : resolve()));
        } catch (_) {}

        // MAIL FROM
        await new Promise((resolve, reject) => conn.mail({ from: fromAddress }, err => err ? reject(err) : resolve()));

        // RCPT TO
        const rcptResult = await new Promise((resolve, reject) => {
          const onRcptErr = (err) => reject(err);
          listeners.push(['error', onRcptErr]);
          conn.once('error', onRcptErr);
          conn.rcpt({ to: emailTrim }, (err, info) => {
            if (err) return reject(err);
            resolve(info || { ok: true });
          });
        });

        try { conn.quit(); } catch (_) { try { conn.close(); } catch(_){} }
        // cleanup listeners
        listeners.forEach(([ev, fn]) => conn.removeListener(ev, fn));
        return res.json({ ok: true, mx: record, info: rcptResult || null });
      } catch (err) {
        try { conn.close(); } catch (_) {}
        listeners.forEach(([ev, fn]) => conn.removeListener(ev, fn));
        const msg = err && err.message ? err.message : String(err);
        if (/5\d\d/.test(msg) || /550/.test(msg) || /Mailbox rejected/i.test(msg)) {
          return res.json({ ok: false, message: 'Mailbox rejected', error: msg });
        }
        // try next MX
        continue;
      }
    }

    return res.json({ ok: false, message: 'All MX servers failed to verify mailbox' });
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Internal error', error: String(e && e.message) });
  }
});

const PORT = process.env.PORT || 3000;
// bind to 0.0.0.0 so the server is reachable from other devices in the LAN
app.listen(PORT, '0.0.0.0', ()=>{
  console.log(`Email server listening on port ${PORT} (bound to 0.0.0.0). SMTP configured: ${SMTP_CONFIGURED}`);
});
