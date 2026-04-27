module.exports = {
  apps: [
    {
      name:          "atrex-ai",
      script:        "dist/index.js",
      cwd:           __dirname,
      restart_delay: 3000, // ms — not a port
      max_restarts:  10,
      watch:         false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
