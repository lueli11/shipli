FROM node:24.22.3-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx next build

FROM node:24.22.3-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Schema beim Start einspielen (CREATE/ALTER ... IF NOT EXISTS, also wiederholbar)
COPY --from=build /app/db ./db
COPY --from=build /app/scripts/db-init.ts ./scripts/db-init.ts
COPY --from=build /app/src/db.ts ./src/db.ts
# zot-sync läuft mit demselben Image als eigener Pod (deploy/shipli.yaml)
COPY --from=build /app/scripts/zot-sync.ts ./scripts/zot-sync.ts
COPY --from=build /app/src/zot-sync.ts /app/src/zot-config.json ./src/
COPY --from=build /app/node_modules/bcryptjs ./node_modules/bcryptjs
USER node
EXPOSE 3000
CMD ["sh", "-c", "node scripts/db-init.ts && exec node server.js"]
