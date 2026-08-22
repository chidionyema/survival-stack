// One cloud-init document, every provider. The VM configures itself and then
// reports in — the control plane never polls it.

// The engine is handed one connection string and nothing else. Working it out
// here, once, is what lets the same image run on either database.
function databaseUrl(env, dbType) {
  if (env.DATABASE_URL) return env.DATABASE_URL
  if (dbType === 'sqlite') return `sqlite://${env.DB_DATA_PATH}/app.db`
  if (dbType === 'postgres') {
    // A postgres box with no password would fall back to a local sqlite file.
    // It would pass its health check and lose every order, so stop here.
    if (!env.DB_PASSWORD) {
      throw new Error('cloud-init: DB_TYPE=postgres needs DB_PASSWORD or DATABASE_URL')
    }
    return `postgresql://postgres:${env.DB_PASSWORD}@db:5432/app`
  }
  throw new Error(`cloud-init: unknown DB_TYPE ${dbType}`)
}

export function renderCloudInit(env, { role, nonce, callbackUrl, originHost, shadow = false, image = null }) {
  const dbType = env.DB_TYPE || 'sqlite'
  const v = {
    DOMAIN: env.DOMAIN,
    // A deploy names the image. Everything else runs whatever is configured.
    ENGINE_IMAGE: image || env.ENGINE_IMAGE,
    ENGINE_PORT: env.ENGINE_PORT,
    DB_TYPE: dbType,
    DATABASE_URL: databaseUrl(env, dbType),
    DB_BACKUP_IMAGE: env.DB_BACKUP_IMAGE,
    DB_DATA_PATH: env.DB_DATA_PATH,
    R2_BUCKET: env.R2_BUCKET,
    R2_ENDPOINT: env.R2_ENDPOINT,
    R2_ACCESS_KEY: env.R2_ACCESS_KEY,
    R2_SECRET_KEY: env.R2_SECRET_KEY,
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    JWT_SECRET: env.JWT_SECRET,
    ORIGIN_HOST: originHost,
    ROLE: role,
    NONCE: nonce,
    CALLBACK: callbackUrl,
    SHADOW: shadow ? 'true' : 'false',
  }
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined || val === null || val === '') {
      throw new Error(`cloud-init: missing value for ${k}`)
    }
  }

  const pg = v.DB_TYPE === 'postgres'
  // The sidecar restores the cluster into DB_DATA_PATH, then postgres starts on
  // top of it. Nothing else in the file knows which database this is.
  const dbService = pg ? `
        db:
          image: postgres:16-alpine
          restart: unless-stopped
          shm_size: 256mb
          env_file: ./.env
          environment:
            PGDATA: ${v.DB_DATA_PATH}
          depends_on:
            init:
              condition: service_completed_successfully
          volumes:
            - ${v.DB_DATA_PATH}:${v.DB_DATA_PATH}
          healthcheck:
            test: ["CMD-SHELL", "pg_isready -U postgres -d app"]
            interval: 5s
            timeout: 5s
            retries: 24
` : ''
  const engineDeps = pg
    ? `db:
              condition: service_healthy`
    : `init:
              condition: service_completed_successfully`
  const backupDeps = pg
    ? `
          depends_on:
            db:
              condition: service_healthy`
    : ''

  return `#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose-v2
  - curl

write_files:
  - path: /opt/survival/Caddyfile
    permissions: '0644'
    content: |
      # The apex serves customers. The origin host is how the control plane and
      # the health check reach THIS box by name, with a real certificate.
      ${v.DOMAIN}, ${v.ORIGIN_HOST} {
        reverse_proxy localhost:${v.ENGINE_PORT}
      }

  - path: /opt/survival/.env
    permissions: '0600'
    content: |
      ROLE=${v.ROLE}
      ORIGIN_HOST=${v.ORIGIN_HOST}
      DOMAIN=${v.DOMAIN}
      ENGINE_PORT=${v.ENGINE_PORT}
      DB_TYPE=${v.DB_TYPE}
      DATABASE_URL=${v.DATABASE_URL}
      DB_DATA_PATH=${v.DB_DATA_PATH}${pg ? `
      POSTGRES_PASSWORD=${env.DB_PASSWORD}
      POSTGRES_DB=app` : ''}
      R2_BUCKET=${v.R2_BUCKET}
      R2_ENDPOINT=${v.R2_ENDPOINT}
      R2_ACCESS_KEY=${v.R2_ACCESS_KEY}
      R2_SECRET_KEY=${v.R2_SECRET_KEY}
      STRIPE_SECRET_KEY=${v.STRIPE_SECRET_KEY}
      JWT_SECRET=${v.JWT_SECRET}

  - path: /opt/survival/compose.yml
    permissions: '0644'
    content: |
      services:${dbService}
        init:
          image: ${v.DB_BACKUP_IMAGE}
          env_file: ./.env
          environment:
            MODE: restore
          volumes:
            - ${v.DB_DATA_PATH}:${v.DB_DATA_PATH}
          command: ["/entrypoint.sh", "restore"]
        engine:
          image: ${v.ENGINE_IMAGE}
          restart: unless-stopped
          depends_on:
            ${engineDeps}
          ports:
            - "127.0.0.1:${v.ENGINE_PORT}:${v.ENGINE_PORT}"
          env_file: ./.env
          volumes:
            - ${v.DB_DATA_PATH}:${v.DB_DATA_PATH}
          healthcheck:
            test: ["CMD", "wget", "-q", "--spider", "http://localhost:${v.ENGINE_PORT}/health"]
            interval: 10s
            timeout: 5s
            retries: 3
            start_period: 30s
        caddy:
          image: caddy:2-alpine
          restart: unless-stopped
          ports:
            - "80:80"
            - "443:443"
          volumes:
            - ./Caddyfile:/etc/caddy/Caddyfile:ro
            - caddy_data:/data
        backup:
          image: ${v.DB_BACKUP_IMAGE}
          restart: unless-stopped${backupDeps}
          env_file: ./.env
          environment:
            MODE: backup
          volumes:
            - ${v.DB_DATA_PATH}:${v.DB_DATA_PATH}
          profiles: ["primary"]
      volumes:
        caddy_data:

  - path: /opt/survival/report-in.sh
    permissions: '0700'
    content: |
      #!/bin/bash
      # Report in when healthy. The control plane is waiting on this, not polling.
      IP=$(curl -fsS --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')
      for i in $(seq 1 60); do
        if curl -fsS --max-time 5 "http://localhost:${v.ENGINE_PORT}/health" >/dev/null; then
          curl -fsS --max-time 15 -X POST "${v.CALLBACK}" \\
            -H 'content-type: application/json' \\
            -d "{\\"nonce\\":\\"${v.NONCE}\\",\\"ip\\":\\"$IP\\",\\"health\\":\\"ok\\",\\"role\\":\\"${v.ROLE}\\",\\"shadow\\":${v.SHADOW}}"
          exit 0
        fi
        sleep 10
      done
      curl -fsS --max-time 15 -X POST "${v.CALLBACK}" \\
        -H 'content-type: application/json' \\
        -d "{\\"nonce\\":\\"${v.NONCE}\\",\\"ip\\":\\"$IP\\",\\"health\\":\\"unhealthy\\",\\"role\\":\\"${v.ROLE}\\",\\"shadow\\":${v.SHADOW}}"

runcmd:
  - systemctl enable --now docker
  - cd /opt/survival && docker compose --profile ${v.ROLE} up -d
  - /opt/survival/report-in.sh
`
}
