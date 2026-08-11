# Authentication

autocode is login-only. There is no signup route, no password-reset route,
and no way to create an account over HTTP — accounts exist only via
`scripts/create-user.ts`, run on the host.

That asymmetry is deliberate. A logged-in session on this app can approve a
plan that runs commands on your machine; the ability to mint a login is
therefore strictly more dangerous than the login itself, and it stays off
the network.

## Creating accounts

```bash
pnpm create-user kevin              # prompts for a password (hidden), twice
pnpm create-user kevin --generate   # generates a strong one, prints it once
pnpm create-user kevin --reset      # change the password; kills their live sessions
pnpm create-user kevin --disable    # disable the account; kills their live sessions
pnpm create-user kevin --enable
pnpm create-user --list
```

Non-interactive (e.g. from a provisioning script): set `AUTOCODE_PASSWORD`.
Another deployment's database: `--config /path/to/autocode.json`.

Passwords must be at least 12 characters. There is no recovery — only
`--reset` from the host.

## How it works

- **Password storage**: scrypt (N=32768, r=8, p=1), 16-byte random salt per
  user, parameters stored alongside the hash so the cost can be raised later
  without invalidating existing passwords.
- **Sessions**: 256-bit random token in an `HttpOnly; SameSite=Strict`
  cookie, marked `Secure` per `auth.cookieSecure` (see the deployment
  section). Only the SHA-256 of the token is stored, so a
  database leak doesn't hand over live sessions. Sessions are server-side
  and therefore revocable — logout, password change, and account disable all
  take effect immediately, because the user row is re-read on every request.
- **Expiry**: 30 days by default (`auth.sessionTtlHours`), sliding — an
  actively used session keeps renewing.
- **Brute force**: failed logins are throttled per IP *and* per username
  (10 failures → 15 minute lockout, both configurable). Unknown usernames
  are verified against a dummy hash so every failure costs the same ~100ms;
  response time doesn't enumerate valid accounts.
- **CSRF**: `SameSite=Strict` means no cross-site request ever carries the
  cookie. As defense in depth, state-changing requests whose `Origin` header
  doesn't match the target host are rejected with 403. A missing `Origin`
  (curl, scripts) is allowed — those aren't subject to CSRF.
- **Coverage**: one `onRequest` guard registered before every route, so the
  API, the SSE stream, and every static asset are all behind it. Only
  `/login.html`, `/login.js`, `/styles.css`, `/favicon.ico` and
  `POST /api/auth/login` are anonymous.

## Deployment: nginx on a remote ZeroTier peer

The configured topology:

```
browser ──HTTPS──> [remote host: nginx, TLS, public domain]
                          │
                    ZeroTier (10.242.0.0/16, encrypted peer-to-peer)
                          │
                   [this host: autocode bound to 10.242.236.182:4600]
```

The app never listens on a public interface. ZeroTier membership is the
outer boundary; the password is the inner one.

### This host (`config/autocode.json`)

```json
"host": "iface:ztr2qyco3w",
"port": 4600,
"trustProxy": "10.242.0.0/16",
"auth": { "cookieSecure": "auto", "trustedOrigins": [] }
```

- **`iface:<name>`** binds to that interface's current IPv4 address. The
  ZeroTier controller assigns that address and can change it, and naming the
  interface also turns "ZeroTier wasn't up yet at boot" into a message that
  says so instead of a bare `EADDRNOTAVAIL`. A literal IP works too.
- **`trustProxy`** is the ZeroTier subnet, so `X-Forwarded-*` is honoured
  from VPN peers and ignored from anywhere else. This is what makes the
  login lockout key on the *real* client instead of on nginx — without it
  every request looks like it came from the proxy, and one attacker's
  failures would lock out everyone. Tighten it to the nginx host's exact
  ZeroTier address if you want.
- **`cookieSecure: "auto"`** marks the cookie `Secure` when the request
  arrived over HTTPS (which nginx reports via `X-Forwarded-Proto`) and not
  when you hit the app directly over the VPN in plain HTTP. A hard `true`
  would hand a direct-over-VPN browser a cookie it then refuses to send
  back, and login would appear to silently fail for no visible reason.

If ZeroTier starts after autocode on boot, order it explicitly — e.g. a
systemd unit with `After=zerotier-one.service` and `Restart=on-failure`.

### The nginx host

```nginx
server {
    listen 443 ssl;
    server_name autocode.example.com;

    ssl_certificate     /etc/letsencrypt/live/autocode.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/autocode.example.com/privkey.pem;

    location / {
        proxy_pass http://10.242.236.182:4600;

        # REQUIRED. nginx defaults Host to the upstream address; the app
        # compares the browser's Origin against it to block cross-site
        # writes, so leaving the default makes every write 403.
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Host  $host;
        # Drives cookieSecure "auto" — without it the session cookie never
        # gets the Secure flag.
        proxy_set_header X-Forwarded-Proto $scheme;
        # Drives the per-client login lockout.
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP         $remote_addr;

        # The live run log is Server-Sent Events. The app already sends
        # X-Accel-Buffering: no, which nginx honours; these make the
        # long-lived connection behave regardless.
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}

server {
    listen 80;
    server_name autocode.example.com;
    return 301 https://$host$request_uri;
}
```

If writes start coming back `403 cross-origin request rejected`, the proxy
isn't forwarding the browser's host. Either fix `proxy_set_header Host`, or
name the origin explicitly:

```json
"auth": { "trustedOrigins": ["https://autocode.example.com"] }
```

### Two consequences of this topology

- **Web push and browser notifications need HTTPS.** Service workers only
  register in a secure context, so notifications work through the nginx
  domain but not when you hit `http://10.242.236.182:4600` directly. The app
  degrades quietly — desktop notifications on the host and the in-page SSE
  feed keep working either way.
- **The public login form is only as private as the ZeroTier network.**
  Anyone authorised on that network can reach the login page directly,
  bypassing nginx. Keep the ZeroTier network private with manual member
  authorisation, and prune members you no longer trust.

## What authentication here does *not* do

- **No per-user isolation.** Every authenticated user sees every project,
  task, run and approval, and can approve any pending command. Accounts are
  a door, not a permission system — only create accounts for people you'd
  hand a shell to.
- **Web push subscriptions aren't per-user** either, for the same reason:
  notifications describe shared state.
- **The login throttle is in-memory**, so a server restart clears active
  lockouts. Rebuilding it costs an attacker another full window, and
  restarts aren't attacker-triggerable, but it's worth knowing.
- **Nothing rate-limits the authenticated API**, only login. An account you
  hand out is an account that can drive the agent as hard as it likes.
