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
| `db` | Postgres 17, data in volume `events-temp_db-data` | internet, port **15432**, encrypted + password only |

Ports published by Docker bypass ufw: whatever is listed under `ports:` is open to the internet.
The database is published on purpose, so teammates' local events-api and pgAdmin can use it
(see "Team database access"). `pg_hba.conf` refuses unencrypted connections.

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

## Team database access

One shared database for everyone: the site at http://169.58.247.85:8080, each teammate's local
events-api and pgAdmin. Everyone uses the same login, **`events`**, which can change data and structure
(migrations). One login on purpose: in Postgres only a table's owner can alter or drop it, and two logins
would end up owning different tables.

The password is the one in `~/events/db.env`. To read it on the server:

```bash
grep POSTGRES_PASSWORD ~/events/db.env
```

Share it privately (password manager or a direct message), never in a group chat. It is also the server
API's password: if it leaks, follow "Changing the database password" below.

### Settings for a teammate's local events-api

Only the database settings change; everything else stays as in their own local setup:

```
POSTGRES_HOST=169.58.247.85
POSTGRES_PORT=15432
POSTGRES_DATABASE=events
POSTGRES_USER=events
POSTGRES_PASSWORD=<the password from db.env>
POSTGRES_SSL=no-verify
SMS_DELIVERY=log
OUTBOX_WORKER_ENABLED=false
```

- `no-verify`: the connection is encrypted, but the certificate is self-signed, so it isn't checked.
- `OUTBOX_WORKER_ENABLED=false`: the server's API already delivers confirmation messages; local APIs
  shouldn't pick them up too. Never set `SMS_DELIVERY=afromessage` against this database.
- Event covers uploaded through a local API are saved on that person's computer, not on the server, so
  others see a broken image. Upload covers through http://169.58.247.85:8080.

### Rules for changing the structure (migrations)

A migration changes the database for everyone at once, including the live site.

1. **Tell the team before you migrate**, and always before `npm run db:migrate:undo`: undoing a
   migration can drop a table and its data for everyone.
2. **Only migrate code that is going to `main`.** A migration from a branch that is later dropped leaves
   tables everyone else's code doesn't expect.
3. **Back up first** (next section).
4. After merging, the server's own code is updated through "Updating to newer code" below. Its
   `migrate.js up` simply finds nothing left to do if the migration already ran.

### pgAdmin

Host `169.58.247.85`, port `15432`, maintenance database `events`, username `events`, the password from
`db.env`; on the **Parameters** tab set **SSL mode** to `require`.

### Backups

Before a migration or any risky change, on the server:

```bash
mkdir -p ~/events/backups && chmod 700 ~/events/backups
cd ~/events/events-api/deploy/contabo-temp
sudo docker compose exec -T db pg_dump -U events -d events -Fc > ~/events/backups/events-$(date +%Y%m%d-%H%M%S).dump
ls -lh ~/events/backups
```

The file should be larger than a few KB. Backups hold all the data: keep them on the server only.

Restoring **replaces the current data for everyone**, so tell the team first:

```bash
cd ~/events/events-api/deploy/contabo-temp
sudo docker compose exec -T db pg_restore -U events -d events --clean --if-exists < ~/events/backups/<file>.dump
```

### Changing the database password

If the password leaked or someone should lose access. The new password is generated on the server and
never shown:

```bash
cd ~/events/events-api/deploy/contabo-temp
NEW=$(openssl rand -hex 24)
sudo docker compose exec -T db psql -U events -d events -c "ALTER ROLE events PASSWORD '$NEW';"
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$NEW/" ~/events/db.env
unset NEW
sudo docker compose up -d --force-recreate api
```

The server API restarts with the new password. Then share the new one (`grep POSTGRES_PASSWORD
~/events/db.env`) with everyone who should keep access; they update their local settings.

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
