# chong-pi

The Pi-side server-process for chong. Holds the bare git repos and CL state.

```
[chong CLI] ──https──► [Cloudflare Tunnel] ──wss──► [cloudflared on Pi]
                                                          │
                                                          ▼
                                                  http://127.0.0.1:8787
                                                          │
                                            ┌─────────────┴─────────────┐
                                            ▼                           ▼
                                    /api/cls/*                  /repos/*.git/*
                                    /api/history                (git http-backend)
                                    /api/commit/:sha                     │
                                            │                           │
                                            └────────────┬──────────────┘
                                                         ▼
                                            ~/.chong-pi/{chong.db, repos/, work/}
```

The `cloudflared` keepalive is the architecture's "ping": Cloudflare knows
the Pi is alive because the tunnel stays open. There are no inbound ports
on the Pi.

## Pi hardware setup

For physical Pi setup — OS image, SSH, networking, USB-SSD boot, power, cooling —
see: <https://grok.com/c/8265e680-d0af-4679-9303-ef8ca753b87a?rid=6503dcf3-ef24-49c9-b024-de12ab5d8104>

This README only covers the chong-pi software install on an already-prepared Pi.

## Requirements

- A small Linux box: Pi 4B (2+ GB) / Pi 5 / any cheap VM
- Bun ≥ 1.1 — note: **ARM64 only**. Pi 2/3 (ARMv7) is unsupported by Bun;
  on those, swap `bun:sqlite` for `better-sqlite3` and run on Node 20+.
- git ≥ 2.30
- cloudflared (for ingress)
- Optional: an Anthropic API key for commit coaching

## Install

```bash
curl -fsSL https://bun.sh/install | bash
git clone <chong-repo> ~/chong && cd ~/chong/pi
bun install
bun src/init.ts
bun src/user-add.ts simon simon@your-domain
```

`init.ts` creates `~/.chong-pi/` with the SQLite db and the `repos/` and
`work/` directories. `user-add.ts` mints a bearer token; hand that to the
developer for `chong auth login`.

## Run

```bash
bun src/index.ts
```

Useful env:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port to bind |
| `BIND` | `127.0.0.1` | Loopback by default; the tunnel reaches in |
| `CHONG_DATA_DIR` | `~/.chong-pi` | Override data directory |
| `ANTHROPIC_API_KEY` | _(unset)_ | Enable AI commit coaching |

For production, drop the included `chong-pi.service` into
`/etc/systemd/system/` and `systemctl enable --now chong-pi`.

## Cloudflare Tunnel ingress

Zero inbound ports on the Pi. `cloudflared` opens an outbound persistent
connection to Cloudflare and registers two hostnames pointing at the same
loopback service:

```yaml
# ~/.cloudflared/config.yml
tunnel: <tunnel-id>
credentials-file: /home/pi/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: chong-api.your-domain.tld
    service: http://127.0.0.1:8787
  - hostname: git.your-domain.tld
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Setup steps:

```bash
sudo apt install cloudflared
cloudflared tunnel login
cloudflared tunnel create chong-pi
# write ~/.cloudflared/config.yml as above
cloudflared tunnel route dns chong-pi chong-api.your-domain.tld
cloudflared tunnel route dns chong-pi git.your-domain.tld
sudo cloudflared service install
```

## Wire up the chong CLI

```bash
chong auth login
# Harness URL: https://chong-api.your-domain.tld
# Personal Access Token: <token from `bun src/user-add.ts`>
```

For `git push`, the working clone needs an `origin` pointing at the Pi.
Until `chong new` is updated to do this automatically, set it manually:

```bash
git remote set-url origin https://git.your-domain.tld/repos/<repo>.git
```

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness; no auth |
| POST | `/api/cls` | Create a CL — requires `{ title, repo }` |
| GET | `/api/cls` | List your CLs (use `?author=`, `?status=`, `?repo=`) |
| GET | `/api/cls/:id` | Fetch one |
| DELETE | `/api/cls/:id` | Abandon |
| POST | `/api/cls/:id/upload` | Trigger squash-merge — body `{ sha }`, returns SSE |
| GET | `/api/history?repo=` | Recent commits on `main` |
| GET | `/api/commit/:sha?repo=` | Commit + diff + AI coaching |
| `*` | `/repos/<name>.git/*` | git smart HTTP (clone/fetch/push) |

All `/api/*` (except `/api/health`) need `Authorization: Bearer <token>`.

## Backups

A git repo on a Pi is one bad SD card away from disaster. Mirror nightly:

```cron
0 3 * * * rclone sync /home/pi/.chong-pi/ b2:chong-backup/
```

Repos are bare git, so `rclone sync` (or `rsync`) is enough — no special
quiescing needed.

## Decisions that bit us if you change them later

- **`work/<repo>/` is a non-bare clone the server uses for merges.**
  This avoids the awkwardness of squash-merging into a bare repo. The
  bare repo at `repos/<repo>.git` is the one devs push to and clone from.
  Server pushes back to the bare after each merge.
- **Branches are deleted from the bare repo after squash-merge.** The
  CLI's worktree cleanup handles the local side.
- **No git-http auth check yet.** The tunnel is the access control. Add
  HTTP basic in `src/routes/git-http.ts` if you ever expose this on a
  non-tunnel hostname.
