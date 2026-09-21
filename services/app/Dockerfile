FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl wget
COPY package.json package-lock.json* ./
RUN npm install
COPY prisma ./prisma
COPY src ./src
COPY public ./public
COPY tsconfig.json nest-cli.json ./
RUN npx prisma generate && npm run build
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["/docker-entrypoint.sh"]
