import express, { Router } from 'express';
import { AppError, asyncRoute } from '../middleware/errorHandler';
import { limits } from '../middleware/rateLimits';
import { accountService } from '../services/accountService';

/**
 * The account deletion page Google Play asks for (its "Delete account URL"): a plain form with the
 * username and password, no script. Players without an account delete from the game itself
 * (Settings > Delete Account), which this page says.
 *
 * GET  /account/delete  -> the form
 * POST /account/delete  username, password (a form) -> deleted, or the form again with what went wrong
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kingdom Smash - Delete your account</title>
<style>
body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#2a0640;color:#fff}
main{max-width:460px;margin:0 auto;padding:32px 20px}
h1{font-size:24px;color:#ffd43a}
p,li{line-height:1.5;color:#efe3ff}
form{background:#4a0a6e;border:2px solid #f2b630;border-radius:14px;padding:18px;margin-top:18px}
label{display:block;margin:10px 0 4px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:0;font-size:16px}
button{margin-top:16px;width:100%;padding:14px;border:0;border-radius:10px;background:#d6283a;color:#fff;font-size:17px;font-weight:700}
.msg{padding:12px;border-radius:8px;margin-top:14px}.err{background:#7a1020}.ok{background:#1f6a3a}
</style></head><body><main>${body}</main></body></html>`;
}

function form(message?: { ok: boolean; text: string }, username = ''): string {
  return page(`<h1>Delete your Kingdom Smash account</h1>
<p>Enter the username and password of your account. Deleting it removes for good:</p>
<ul><li>your username and password</li><li>your saved game (levels, coins, boosters and everything else)</li><li>your place on the world leaderboard</li><li>your invite code</li></ul>
<p>Records of purchases are kept for the store's refunds and fraud checks, no longer linked to you. Server logs are erased after 30 days.</p>
<p>Played without an account? Delete your data from the game: <b>Settings &gt; Delete Account</b>.</p>
${message ? `<div class="msg ${message.ok ? 'ok' : 'err'}">${esc(message.text)}</div>` : ''}
<form method="post" action="/account/delete">
<label for="u">Username</label><input id="u" name="username" autocomplete="username" maxlength="64" required value="${esc(username)}">
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" maxlength="64" required>
<button type="submit">Delete my account</button>
</form>`);
}

export function createAccountPageRouter(): Router {
  const router = Router();
  router.get('/delete', (_req, res) => {
    res.type('html').send(form());
  });
  router.post(
    '/delete',
    limits.deletePage,
    express.urlencoded({ extended: false, limit: '4kb' }),
    asyncRoute(async (req, res) => {
      const username = typeof req.body?.username === 'string' ? req.body.username.slice(0, 64) : '';
      const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 64) : '';
      try {
        await accountService.removeWithPassword(username, password);
        res.type('html').send(page(`<h1>Your account is deleted</h1><p>The account <b>${esc(username)}</b> and its saved game are gone for good. If the game is still on a phone, it starts as a new player there.</p>`));
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        const text = err.code === 'account_locked' ? 'Too many wrong passwords. Please try again in 15 minutes.' : 'The username or password is wrong.';
        res.status(err.status).type('html').send(form({ ok: false, text }, username));
      }
    }),
  );
  return router;
}
