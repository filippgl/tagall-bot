// filename: ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "tagall-bot",
      script: "bot.js",
      exec_mode: "fork",
      instances: 1,
      env: {
        NODE_ENV: "production"
      },
      max_memory_restart: "300M",
      autorestart: true
    }
  ]
};
