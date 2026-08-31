# Named tunnel setup — `byteplus.cloudflared.hk`

Why bother: free quick tunnels are throttled to roughly **100–400 KB/s**. BytePlus
downloads your reference clip server-side and gives up if it's slow, which is the
`timeout while fetching resource` error on clips over ~10 MB. Measured on a quick
tunnel: **5 MB took 47s, 20 MB took 55s** — the same files serve locally in 0.02s.

A named tunnel on your own domain removes the throttle and gives you a hostname that
never rotates. The server runs it **only while `node server.js` is running** — nothing is
installed as a background service.

---

## Prerequisites

- `cloudflared` installed (`brew install cloudflared`)
- `cloudflared.hk` active in the **same Cloudflare account** you'll log in with

---

## Step 1 — Authorize the `cloudflared.hk` zone

Your machine already has a cert at `~/.cloudflared/cert.pem`, but it's scoped to
**`naphysio.hk`**. That's why `cloudflared tunnel route dns ... byteplus.cloudflared.hk`
silently produced `byteplus.cloudflared.hk.naphysio.hk` — it appended its own zone.

Logging in again **overwrites** `cert.pem`. Back it up first, since your other tunnels
were created under it:

```bash
cp ~/.cloudflared/cert.pem ~/.cloudflared/cert.pem.naphysio.bak
cloudflared tunnel login
```

A browser opens — pick **`cloudflared.hk`** from the zone list and authorize.

> Already-created tunnels keep working: each one authenticates with its own
> `<uuid>.json` credentials file, not with `cert.pem`. The cert only authorizes
> *creating* tunnels and DNS routes. The backup lets you restore the old scope if you
> ever need to add routes on `naphysio.hk` again.

Verify the new scope:

```bash
cloudflared tunnel list   # should still list your existing tunnels
```

---

## Step 2 — Create the tunnel

```bash
cloudflared tunnel create byteplus-studio
```

Prints a tunnel UUID and writes credentials to `~/.cloudflared/<uuid>.json`. **Keep that
file** — it's what lets the server run the tunnel. Anyone holding it can serve traffic on
your hostname, so don't commit it.

---

## Step 3 — Point the hostname at it

```bash
cloudflared tunnel route dns byteplus-studio byteplus.cloudflared.hk
```

Expected output names the bare hostname:

```
INF Added CNAME byteplus.cloudflared.hk which will route to this tunnel
```

**If it prints `byteplus.cloudflared.hk.naphysio.hk`, stop** — Step 1 didn't take, and the
cert is still scoped to the old zone. Re-run the login and select `cloudflared.hk`.

Confirm DNS resolves (give it a few seconds):

```bash
dig +short byteplus.cloudflared.hk
```

Cloudflare edge IPs (e.g. `104.21.x.x`) mean the record is live.

---

## Step 4 — Tell the app to use it

Add to `.env`:

```ini
TUNNEL_NAME=byteplus-studio
TUNNEL_HOSTNAME=byteplus.cloudflared.hk
```

Leave `PUBLIC_BASE_URL` empty — the server sets it from `TUNNEL_HOSTNAME` at boot. (In
named mode it does **not** rewrite `.env`, unlike quick-tunnel mode.)

---

## Step 5 — Start and verify

```bash
node server.js
```

Expected:

```
[TUNNEL] starting named tunnel "byteplus-studio" → https://byteplus.cloudflared.hk
[TUNNEL] up → https://byteplus.cloudflared.hk
[TUNNEL] uploads enabled via https://byteplus.cloudflared.hk
```

Check from outside:

```bash
curl -s https://byteplus.cloudflared.hk/api/health
```

Should report `"videoUploadsEnabled": true` with your hostname as `publicBaseUrl`.

Measure the throughput gain — this is the whole point:

```bash
mkdir -p videos/staging
dd if=/dev/urandom of=videos/staging/_speed.bin bs=1m count=20
curl -s -o /dev/null -w "%{time_total}s @ %{speed_download} B/s\n" \
  https://byteplus.cloudflared.hk/videos/staging/_speed.bin
rm videos/staging/_speed.bin
```

A quick tunnel took ~55s for 20 MB. Expect a few seconds here.

---

## Lifecycle

The tunnel is a child process of the server:

- starts when `node server.js` starts,
- dies on `Ctrl-C` / `SIGTERM` — no orphan is left behind,
- auto-restarts (2s → 60s backoff) if it drops while the server runs,
- keeps the **same** hostname across restarts.

While it's reconnecting, uploads report unavailable and pasted URLs keep working.

---

## Troubleshooting

**`tunnel not found` / credentials errors on startup** — the tunnel was deleted, or its
`~/.cloudflared/<uuid>.json` is missing. Check `cloudflared tunnel list`. The server logs
the reason rather than looping silently.

**DNS record ends up on the wrong zone** — Step 1 didn't take. Re-run
`cloudflared tunnel login` and select `cloudflared.hk`.

**Error 1016 when visiting the hostname** — DNS points at a tunnel that isn't running.
Start the server; the record is only live while it is.

**Removing a DNS record** — `cloudflared` can create routes but not delete them. Use the
Cloudflare dashboard (DNS → find the record → Delete) or the API with a
`Zone.DNS:Edit` token.

**Reverting to a quick tunnel** — remove `TUNNEL_NAME` and `TUNNEL_HOSTNAME` from `.env`.
