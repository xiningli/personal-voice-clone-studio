# Next.js web app. Two stages: install + build, then a slim runtime image.
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Self-signed dev certs and the vendored backend/Python bits are not part of the web build.
RUN rm -rf certs backend datasets models exports data public/audio
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/content ./content
COPY --from=builder /app/styles ./styles

EXPOSE 3010
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=10 \
    CMD node -e "fetch('http://127.0.0.1:3010/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "next", "start", "--port", "3010", "--hostname", "0.0.0.0"]
