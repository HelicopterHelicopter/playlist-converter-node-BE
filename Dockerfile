# ---- Base Node ----
FROM node:20-alpine AS base
WORKDIR /app
# Install PM2 globally within the image
RUN npm install pm2 -g

# ---- Dependencies ----
FROM base AS dependencies
# Copy package files
COPY package.json package-lock.json ./
# Install production dependencies only
RUN npm install --only=production
# Copy PM2 config
COPY ecosystem.config.js ./

# ---- Build ----
# Optional: Add a build stage here if you had build steps like TypeScript compilation

# ---- Release ----
FROM base AS release
WORKDIR /app
# Copy dependencies from the 'dependencies' stage
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/ecosystem.config.js ./ecosystem.config.js
# Copy application code
COPY . .

# Expose the port the app runs on (from .env or default)
EXPOSE 5000

# Define the command to run the application using pm2-runtime in production mode
# This automatically uses the ecosystem.config.js file in the current directory
CMD ["pm2-runtime", "start", "ecosystem.config.js", "--env", "production"] 