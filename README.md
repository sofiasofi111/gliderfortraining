# Email confirmation backend (local)

This project contains a simple static frontend and a small Node.js server (`server.js`) which can send confirmation codes via SMTP using Nodemailer.

Usage

1. Install dependencies:

```bash
npm install
```

2. Set environment variables (example for Windows PowerShell):

```powershell
$env:SMTP_HOST = 'smtp.example.com'
$env:SMTP_PORT = '587'
$env:SMTP_USER = 'your_smtp_user'
$env:SMTP_PASS = 'your_smtp_password'
$env:FROM_EMAIL = 'no-reply@example.com'
node server.js
```

On Linux/macOS use `export SMTP_HOST=...`.

3. Run server:

```bash
npm start
```

Server listens on port 3000 by default and exposes endpoint `POST /send-code` expecting JSON:

```json
{ "email": "user@example.com", "username": "bob", "code": "123456" }
```

4. Frontend (`confirm.html`) will POST to `/send-code` when generating/resent code. If server is not running, the code will be logged to the browser console for testing.

Security notes

- This is a minimal testing server. Do NOT expose it to the public internet without proper security.
- The server includes a simple in-memory rate limiter (per email and per IP): max 3 sends per 15 minutes. If a client exceeds the limit, `/send-code` returns HTTP 429.
- Failed sends are retried up to several times and queued for background retries. Failed items are kept in memory only — restarting the server clears the queue.
- For production use, add persistent queues, stronger rate-limiting, request validation, authentication, and store secrets securely.
