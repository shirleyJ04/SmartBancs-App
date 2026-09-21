#!/bin/sh
set -e
npx prisma migrate deploy
if [ "${APP_ROLE:-api}" = "api" ]; then
  npx tsx prisma/seed.ts
fi
exec node dist/main.js
