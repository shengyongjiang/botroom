# Running on the LAN (Docker)

The dashboard in a container, reachable from a phone on the same network.
Host port **4546**; port 4545 is the original local demo and is left alone.

The container runs **demo data by default**: no host mounts, no real logs, no
credentials. Nothing is exposed to the internet.

## Start

```sh
cp .env.example .env          # once; .env is gitignored
docker compose up -d --build
docker compose ps             # wait for "(healthy)"
```

Open `http://localhost:4546` on this machine, or the LAN address on a phone.

## Stop / restart / logs

```sh
docker compose restart        # after changing .env
docker compose stop           # keep the container
docker compose down           # remove it
docker compose logs -f        # follow logs
docker compose logs --tail 50 # last 50 lines
```

Rebuild after pulling code:

```sh
docker compose up -d --build
```

## Health

```sh
docker inspect --format '{{.State.Health.Status}}' $(docker compose ps -q)
curl -fsS http://127.0.0.1:4546/api/ping
# {"app":"whatsmyagentdoing","admin":"loopback","demo":true}
```

The healthcheck fetches `/api/ping` from inside the container every 30 s.

## The LAN address

Find it on the host:

```sh
ipconfig getifaddr en0                 # macOS, Wi-Fi
ifconfig | grep 'inet ' | grep -v 127  # any platform
```

Then open `http://<that-address>:4546` on the phone (same Wi-Fi). The startup
log prints the address it detected. If the page does not load, check that the
host firewall allows inbound TCP 4546.

## Admin on the LAN (optional)

Reads (`/api/sessions`, `/events`, `/api/scenes`, the page) are open to the LAN.
Writes stay **loopback-only** unless a token is configured:

- `POST /api/update`, `POST /api/shutdown`, `POST /api/scenes/install` return
  `403 {"ok":false,"error":"admin disabled on LAN"}` from any non-loopback
  client, whatever `X-Forwarded-For`, `Forwarded`, `Host` or `Origin` it sends.
- The browser page never stores a token; the token is for `curl`.

To unlock them, create a token file (never commit it) and enable the secret:

```sh
mkdir -p secrets
openssl rand -hex 24 > secrets/wmad_admin_token
# uncomment `secrets:` and the top-level `secrets:` block in docker-compose.yml
echo 'WMAD_ADMIN_TOKEN_FILE=/run/secrets/wmad_admin_token' >> .env
docker compose up -d
curl -X POST -H "Authorization: Bearer $(cat secrets/wmad_admin_token)" \
     -H 'x-whatsmyagentdoing: install' \
     'http://<lan-address>:4546/api/scenes/install?id=office'
```

`secrets/` and `.env` are gitignored.

## Real data instead of demo

Demo is the default on purpose. To show real sessions, set `WMAD_DEMO=0` and
mount the agent logs **read-only** (the commented `volumes:` block in
`docker-compose.yml`), e.g. `~/.claude:/home/node/.claude:ro`. Only mount what
you want visible; prompts and replies are readable by anyone on the LAN. To
show status only, add `command: ["node", "bin/cli.js", "--no-open", "--private"]`
to the service.

## Reverse proxy, HTTPS and the auth boundary

Put a proxy in front when you want TLS or a login. The container stays on the
LAN; **do not publish 4546 to the internet.**

- Terminate TLS at the proxy (Caddy, nginx, Traefik) and forward to
  `http://127.0.0.1:4546`.
- Add the public name to the Host allow list, e.g.
  `WMAD_ALLOWED_HOSTS=botroom.example.lan,*.lan`.
- Only if the proxy runs on the **same host** and you need real client
  addresses, set `WMAD_TRUST_PROXY=1`. The first `X-Forwarded-For` hop is then
  used **only when the socket peer is loopback**; a direct LAN client cannot
  spoof its way to admin.
- Authentication belongs at the proxy (basic auth, OIDC, mTLS). The app has no
  user accounts; its only access control is the loopback/token admin gate.
- The page uses relative URLs only, so it works behind any path or hostname
  the proxy serves.

## Notes

- Non-root (`node`, uid 1000), `cap_drop: ALL`, `no-new-privileges`,
  read-only root with tmpfs for `/tmp` and the scene cache. No docker socket,
  no `$HOME`, log or PID mounts.
- The image is built from the working tree, so it picks up uncommitted edits;
  `public/office3d.js` is rebuilt from `web/office3d.js` during the build.
- `WMAD_NO_UPDATE_CHECK=1` is set in the image: no outbound version check.
