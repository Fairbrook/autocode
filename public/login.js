// Login page. Deliberately standalone — it must not import app.js, which
// assumes an authenticated session.
const form = document.getElementById("login-form");
const errorEl = document.getElementById("login-error");
const submitEl = document.getElementById("submit");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.textContent = "";
  submitEl.disabled = true;
  submitEl.textContent = "Signing in…";

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("username").value,
        password: document.getElementById("password").value,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      errorEl.textContent = data?.error || `Sign-in failed (${res.status})`;
      document.getElementById("password").value = "";
      return;
    }
    // Full navigation rather than a hash change: the app boots assuming a
    // live session, and this guarantees it starts from a clean state.
    location.href = "/";
  } catch {
    errorEl.textContent = "Could not reach the server.";
  } finally {
    submitEl.disabled = false;
    submitEl.textContent = "Sign in";
  }
});

document.getElementById("username").focus();
