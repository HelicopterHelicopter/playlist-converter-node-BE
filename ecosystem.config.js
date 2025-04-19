module.exports = {
  apps : [{
    name   : "playlist-converter-backend", // A name for your application in PM2
    script : "./server.js",               // The script PM2 will run
    instances: 2, // Number of instances to launch in cluster mode
    exec_mode: "cluster", // Enable cluster mode
    watch  : process.env.NODE_ENV !== 'production', // Watch only in non-production
    // watch_delay: 1000,                 // Optional: Delay between file change detection and restart
    ignore_watch : ["node_modules", ".git", "*.log"], // Folders/files to ignore when watching
    max_memory_restart: '512M',          // Restart app if it exceeds 512MB memory usage
    log_date_format: "YYYY-MM-DD HH:mm:ss Z", // Consistent log timestamp format
    env: {                               // Default environment variables
       NODE_ENV: "development"           // Set default Node environment
       // PM2 automatically loads .env if it exists, no need to list vars here usually
    },
    env_production: {                    // Environment variables for production (--env production)
       NODE_ENV: "production",
       // watch is automatically false due to the conditional logic above
    }
  }]
} 