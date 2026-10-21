// pm2 start ecosystem.config.js --env production
module.exports = {
  apps: [
    {
      name: 'speedplus',
      script: 'server.mjs',
      cwd: __dirname,
      instances: 1, // lobby rooms live in memory -> keep a single instance
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '600M',
      watch: false,
      time: true,
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        HOST: '0.0.0.0',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '0.0.0.0',
        ADMIN_PASSWORD: 'CHANGE_ME', // 請改掉
        // MODELS_DIR: '/var/lib/speedplus/models',
        // DATA_DIR: '/var/lib/speedplus/data',
        // ICE_SERVERS: '[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:your.turn.host:3478","username":"u","credential":"p"}]',
      },
    },
  ],
};
