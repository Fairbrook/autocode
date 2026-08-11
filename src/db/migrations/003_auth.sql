-- Login-only authentication: accounts are created out-of-band by
-- scripts/create-user.ts, never through the HTTP surface. There is no
-- signup endpoint, no password-reset endpoint, and no way to create a user
-- from the network — an internet-exposed instance of this harness can run
-- arbitrary code on the host, so account creation stays on the box.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  -- Stored already lowercased by the repo layer, so lookups are predictable
  -- without relying on a collation.
  username TEXT NOT NULL UNIQUE,
  -- Self-describing scrypt string: scrypt$N=...,r=...,p=...$salt$hash.
  -- Carrying the parameters means the cost can be raised later without
  -- invalidating existing passwords.
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  password_changed_at TEXT NOT NULL,
  last_login_at TEXT
);

-- Server-side sessions (not JWTs): revocable on logout and on password
-- change, which matters far more here than statelessness — there is exactly
-- one server process and it already owns a database.
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  -- SHA-256 of the cookie value. The token is 256 bits of CSPRNG output, so
  -- a fast hash is enough: there is nothing to brute-force. Storing the hash
  -- rather than the token means a database leak doesn't hand over live
  -- sessions.
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
