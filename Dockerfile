FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY migrations/ ./migrations/
COPY docker-entrypoint.sh ./

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=15s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw 1})"

ENTRYPOINT ["./docker-entrypoint.sh"]
