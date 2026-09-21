FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache wget
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY sql ./sql
RUN npm run build
EXPOSE 3001
CMD ["node", "dist/main.js"]
