# Temporary deployment: Contabo VPS

**Temporary.** It runs until events gets a real setup like bookings. Removal is at the end of this file.

- Address: **https://eventra-dev.duckdns.org** (website) and **https://eventra-dev.duckdns.org/api** (API).
  The name is a free DuckDNS subdomain pointing at 169.58.247.85.
- The VPS is shared. Caddy (ports 80/443, the Fidel and Moodle sites) and the Fidel containers belong to
  teammates. The only change made to Caddy is the events block (section "Caddy"); never change, restart or
  remove anything else of theirs. Never run `docker system prune` or other bulk removals.
- Everything here runs as user `joedee`. Docker commands use `sudo`.

## What runs

| Container | What | Reachable from |
|---|---|---|
| Caddy (the server's, not ours) | https for `eventra-dev.duckdns.org` → `127.0.0.1:8080` | internet, ports 80/443 |
| `nginx` | `/api/*` → API (prefix removed), everything else → web | this server only, `127.0.0.1:8080` |
| `web` | events-web, `next start`; server-rendered pages call `http://api:5010` directly | inside Docker only |
| `api` | events-api, `node dist/server.js` | inside Docker only |
| `db` | Postgres 17, data in volume `events-temp_db-data` | internet, port **15432**, encrypted + password only |

Ports published by Docker bypass ufw: a port listed under `ports:` without `127.0.0.1:` is open to the
internet. The database is published on purpose, so teammates' local events-api and pgAdmin can use it
(see "Team database access"). `pg_hba.conf` refuses unencrypted connections.

## Which file lives where

| Repo | Files | Purpose |
|---|---|---|
| events-api | `Dockerfile`, `.dockerignore` | builds the API image (stays after this deployment is removed) |
| events-web | `Dockerfile`, `.dockerignore` | builds the web image (stays after this deployment is removed) |
| events-api | `deploy/contabo-temp/` (this folder) | runs both on this server: compose, nginx, deploy script, these steps |
| events-api, events-web | `.github/workflows/deploy-contabo-temp.yml` | deploys `main` automatically (temporary) |

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

Every other setting is in `docker-compose.yml`: the public address, `/api` cookie paths, SMS only logged.

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

Then add the events block to Caddy (next section) and open https://eventra-dev.duckdns.org.

Logs: `sudo docker compose logs --tail=100 api` (or `web`, `nginx`, `db`).

## Caddy

The server's Caddy serves teammates' sites too, so a mistake in its file affects them. Always validate
before reloading; a reload keeps the other sites running.

1. Back up the file, then open it:

   ```bash
   sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)
   sudo nano /etc/caddy/Caddyfile
   ```

2. Add this block at the end, leaving the existing sites untouched:

   ```
   # Events (temporary deployment: ~/events, user joedee)
   eventra-dev.duckdns.org {
   	encode zstd gzip
   	reverse_proxy 127.0.0.1:8080
   }
   ```

3. Check, then reload only if the check passes:

   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   sudo systemctl reload caddy
   sudo systemctl status caddy --no-pager | head -5
   ```

   If `validate` fails, fix the block (or restore the backup with `sudo cp /etc/caddy/Caddyfile.bak-<time>
   /etc/caddy/Caddyfile`) and don't reload. Caddy fetches the https certificate on the first visit; that
   can take up to a minute.

## Team database access

One shared database for everyone: the site at https://eventra-dev.duckdns.org, each teammate's local
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
POSTGRES_HOST=eventra-dev.duckdns.org
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
  others see a broken image. Upload covers through https://eventra-dev.duckdns.org.

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

Host `eventra-dev.duckdns.org` (or `169.58.247.85`), port `15432`, maintenance database `events`, username `events`, the password from
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

Normally automatic (next section). By hand, the same thing:

```bash
sudo events-deploy api   # pull events-api, back up the database, build, migrate, restart
sudo events-deploy web   # pull events-web, build, restart
```

## Automatic deploys (CI/CD)

Every push to `main` (merged PRs included) deploys that repo: events-api runs `events-deploy api`,
events-web runs `events-deploy web`. Workflow: `.github/workflows/deploy-contabo-temp.yml` in each repo;
results in each repo's **Actions** tab, where "Run workflow" also starts a deploy by hand.

How it is locked down:

- `/usr/local/bin/events-deploy` (this folder's `events-deploy.sh`) is owned by root and accepts only `api` or
  `web`. One deploy runs at a time; a second one waits.
- GitHub holds an SSH key that can run that script and nothing else: no shell, no port forwarding.
- `joedee` may run that one script with sudo without a password (GitHub can't type one). Nothing else.
- Every api deploy backs up the database first, to `~/events/backups/` (newest 20 kept).
- Secrets managed in GitHub (see "Secrets managed in GitHub") reach the server only through the SSH connection's
  input, and only names the script allows are accepted.

Migrations now run automatically on every events-api merge to `main`; see the migration rules above.

### One-time setup on the server (as joedee)

1. Install the script (root-owned, so neither GitHub nor joedee can change what it does):

   ```bash
   cd ~/events/events-api && git pull
   sudo install -o root -g root -m 755 ~/events/events-api/deploy/contabo-temp/events-deploy.sh /usr/local/bin/events-deploy
   ```

2. Allow joedee to run only that script without a password, and check the rule:

   ```bash
   echo 'joedee ALL=(root) NOPASSWD: /usr/local/bin/events-deploy' | sudo tee /etc/sudoers.d/events-deploy
   sudo chmod 440 /etc/sudoers.d/events-deploy
   sudo visudo -cf /etc/sudoers.d/events-deploy
   ```

   `visudo` must say `parsed OK`. If it doesn't, remove the file (`sudo rm /etc/sudoers.d/events-deploy`).

3. Try it by hand once:

   ```bash
   sudo events-deploy api
   ```

   It should end with `done: api`.

4. Create GitHub's key and lock it to the script:

   ```bash
   ssh-keygen -t ed25519 -N "" -C "github-actions-events-deploy" -f ~/events/github-deploy-key
   opts='restrict,command="sudo -n /usr/local/bin/events-deploy \"$SSH_ORIGINAL_COMMAND\""'
   echo "$opts $(cat ~/events/github-deploy-key.pub)" >> ~/.ssh/authorized_keys
   tail -1 ~/.ssh/authorized_keys
   ```

   The last line must start with `restrict,command="sudo -n /usr/local/bin/events-deploy`.

5. The three values for the secrets:

   ```bash
   cat ~/events/github-deploy-key                                                        # CONTABO_DEPLOY_KEY
   echo "169.58.247.85 $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"           # CONTABO_KNOWN_HOSTS
   echo 169.58.247.85                                                                  # CONTABO_HOST
   ```

   Send `CONTABO_DEPLOY_KEY` privately (never a group chat). Once Amir has added it, delete the private key
   from the server: `rm ~/events/github-deploy-key` (the `.pub` file can stay).

### Secrets (a repo admin, in both repos)

GitHub → repo → **Settings → Secrets and variables → Actions → New repository secret**, in **both**
`amikingo/events-api` and `amikingo/events-web`:

| Name | Value |
|---|---|
| `CONTABO_DEPLOY_KEY` | the whole private key, from `-----BEGIN` to `-----END ... KEY-----` |
| `CONTABO_KNOWN_HOSTS` | the `169.58.247.85 ssh-ed25519 AAAA…` line |
| `CONTABO_HOST` | `169.58.247.85` |

Then **Actions → Deploy to Contabo (temporary) → Run workflow** in each repo to test.

### Secrets managed in GitHub

Some app secrets live in GitHub instead of being typed on the server. Every events-api deploy sends them over the
SSH connection's input (never the command line, so they don't show in process lists or logs); the script writes
each one into `~/events/api.env`, replacing only that line, readable by joedee only, and then restarts the API.

| Secret (in **events-api** only) | Used for |
|---|---|
| `PLATFORM_SMS_AFROMESSAGE_TOKEN` | Cheche's platform AfroMessage token (real SMS) |

- Only names listed in `ALLOWED_SECRETS` in `events-deploy.sh` are accepted; anything else is ignored.
- An empty or missing secret changes nothing, so deleting it in GitHub never wipes the server's value.
- Values are never logged; the deploy log only says `updated <NAME> in api.env`.
- A manual `sudo events-deploy api` from a terminal leaves `api.env` as it is.

To change a value: edit the secret in GitHub, then **Actions → Deploy to Contabo (temporary) → Run workflow** in
events-api. To check it arrived without showing it: `cut -d= -f1 ~/events/api.env`.

The token still has to be on the server while the API runs; GitHub is where it is managed. Anyone who can change
the workflow on `main` could read GitHub secrets, so keep merge rights to people you trust.

### Changing the script later

Edit `events-deploy.sh` in the repo, merge, then install it again (step 1). An api deploy prints a NOTE when
the repo copy changed but the installed one wasn't updated.

To turn automatic deploys off: delete the key's line from `~/.ssh/authorized_keys`. To remove everything:
also `sudo rm /etc/sudoers.d/events-deploy /usr/local/bin/events-deploy` and delete the two workflow files.

## Removing it

**This deletes the events database and uploaded files for good.** Only events-temp containers, volumes and
images are touched.

```bash
cd ~/events/events-api/deploy/contabo-temp
sudo docker compose down -v --rmi local
rm -rf ~/events
```

Then turn off automatic deploys (end of "Automatic deploys"), remove the events block from
`/etc/caddy/Caddyfile` (validate and reload as in "Caddy"), delete the
`eventra-dev` domain on duckdns.org, and delete this `deploy/contabo-temp/` folder from the repo. The two
Dockerfiles stay: the real setup can build from them.
