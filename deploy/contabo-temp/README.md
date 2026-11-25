# Temporary deployment: Contabo VPS

**Temporary.** It runs until events gets a real setup like bookings. Removal is at the end of this file.

- Address: **http://169.58.247.85:8080** (website) and **http://169.58.247.85:8080/api** (API)
- The VPS is shared. Caddy (ports 80/443, the Fidel and Moodle sites) and the Fidel containers belong to
  teammates: never change, restart or remove them. Never run `docker system prune` or other bulk removals.
- Everything here runs as user `joedee`. Docker commands use `sudo`.

## What runs

| Container | What | Reachable from |
|---|---|---|
| `nginx` | `/api/*` → API (prefix removed), everything else → web | internet, port **8080** |
| `web` | events-web, `next start` | inside Docker only |
| `api` | events-api, `node dist/server.js` | inside Docker only |
| `db` | Postgres 17, data in volume `events-temp_db-data` | inside Docker only |

Ports published by Docker bypass ufw, so only nginx publishes one. Never add `ports:` to `db`.

## Which file lives where

| Repo | Files | Purpose |
|---|---|---|
| events-api | `Dockerfile`, `.dockerignore` | builds the API image (stays after this deployment is removed) |
| events-web | `Dockerfile`, `.dockerignore` | builds the web image (stays after this deployment is removed) |
| events-api | `deploy/contabo-temp/` (this folder) | runs both on this server: compose, nginx, these steps |

## Layout on the server

```
~/events/
  events-api/      git clone (this folder: events-api/deploy/contabo-temp/)
  events-web/      git clone
  db.env           secrets, created on the server, never in git
  api.env          secrets, created on the server, never in git
```

## 1. Get the code

```bash
mkdir -p ~/events && cd ~/events
git clone https://github.com/amikingo/events-api.git
git clone https://github.com/amikingo/events-web.git
```

If GitHub asks for a username and password, the repo is private and needs a read-only deploy key.
Ask before setting one up.

## 2. Create the two secrets files

The database password is generated on the server and goes straight into the file, so nobody has to see it:

```bash
cd ~/events
umask 077
printf 'POSTGRES_USER=events\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > db.env
nano api.env
```

In `api.env`, write two lines, with no quotes and no spaces around `=`:

```
APP_AUTH_TOKEN=<auth-cheche shared secret, the same one bookings_api uses; at least 32 characters>
CENTRAL_AUTH_SERVICE_ID=<temporarily the bookings service_id>
```

Save with Ctrl+O, Enter, Ctrl+X. Then:

```bash
chmod 600 ~/events/db.env ~/events/api.env
```

Every other setting is in `docker-compose.yml`: no domain, plain http, cookies not `Secure`, SMS only logged.

## 3. Build

```bash
cd ~/events/events-api/deploy/contabo-temp
sudo docker compose build
```

## 4. Start the database, then migrate

```bash
sudo docker compose up -d db
sudo docker compose ps                                              # db should show "healthy"
sudo docker compose run --rm api node dist/scripts/migrate.js status
sudo docker compose run --rm api node dist/scripts/migrate.js up
```

## 5. First super admin

```bash
sudo docker compose run --rm api node dist/scripts/bootstrap-super-admin.js --user-id <central-auth-user-uuid>            # preview
sudo docker compose run --rm api node dist/scripts/bootstrap-super-admin.js --user-id <central-auth-user-uuid> --confirm  # apply
```

## 6. Start everything

```bash
sudo docker compose up -d
sudo docker compose ps
curl -s http://localhost:8080/api/health/ready
```

Then open http://169.58.247.85:8080 in a browser. If it doesn't load from your Mac but the `curl` works,
check whether a firewall in the Contabo panel (Network → Firewall) is assigned to this VPS.

Logs: `sudo docker compose logs --tail=100 api` (or `web`, `nginx`, `db`).

## Updating to newer code

```bash
cd ~/events/events-api && git pull
cd ~/events/events-web && git pull
cd ~/events/events-api/deploy/contabo-temp
sudo docker compose build
sudo docker compose run --rm api node dist/scripts/migrate.js up
sudo docker compose up -d
```

## Removing it

**This deletes the events database and uploaded files for good.** Only events-temp containers, volumes and
images are touched.

```bash
cd ~/events/events-api/deploy/contabo-temp
sudo docker compose down -v --rmi local
rm -rf ~/events
```

Then delete this `deploy/contabo-temp/` folder from the repo. The two Dockerfiles stay: the real setup can
build from them.
