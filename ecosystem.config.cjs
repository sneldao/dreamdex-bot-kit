/**
 * PM2 ecosystem config for the CHIME house bot (ec-chime strategy).
 *
 * Deploy: rsync to /opt/ec-chime on the VPS, then pm2 start ecosystem.config.cjs
 *
 * Env vars live in /opt/ec-chime/shared/.env (symlinked into each release).
 */
module.exports = {
  apps: [
    {
      name: 'ec-chime',
      script: 'node_modules/.bin/tsx',
      args: 'strategies/ec-chime/src/index.ts',
      cwd: '/opt/ec-chime/current',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/opt/ec-chime/logs/ec-chime-err.log',
      out_file: '/opt/ec-chime/logs/ec-chime-out.log',
      log_file: '/opt/ec-chime/logs/ec-chime.log',
      time: true,
      autorestart: true,
      max_memory_restart: '512M',
      restart_delay: 10000,
      exp_backoff_restart_delay: 1000,
      watch: false,
      kill_timeout: 8000,
    },
  ],
}
