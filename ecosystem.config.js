/**
 * PM2 Ecosystem Configuration
 * 
 * Start with: pm2 start ecosystem.config.js
 * Stop with:  pm2 stop ecosystem.config.js
 * Restart:    pm2 restart ecosystem.config.js
 * Logs:       pm2 logs
 */

module.exports = {
    apps: [
        {
            name: 'arma-whitelist',
            script: './index.js',
            cwd: __dirname,
            
            // Instance configuration
            instances: 1,
            exec_mode: 'fork',
            
            // Restart configuration
            restart_delay: 5000,
            max_restarts: 10,
            min_uptime: '10s',
            
            // Watch configuration (disabled for production)
            watch: false,
            ignore_watch: ['node_modules', 'database', 'logs'],
            
            // Environment
            env: {
                NODE_ENV: 'production'
            },
            
            // Logging
            log_file: './logs/combined.log',
            out_file: './logs/out.log',
            error_file: './logs/error.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            merge_logs: true,
            
            // Memory management
            max_memory_restart: '500M',
            
            // Shutdown
            kill_timeout: 5000,
            wait_ready: false,
            listen_timeout: 3000
        }
    ]
};
