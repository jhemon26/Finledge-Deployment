module.exports = {
  apps: [
    {
      name: 'finledge',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '250M',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 3005,
        DB_PATH: '/var/www/spending-app/database.sqlite',
      },
    },
  ],
};
