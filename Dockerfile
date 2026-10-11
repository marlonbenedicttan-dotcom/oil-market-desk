FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Zero runtime dependencies — no install step needed.
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
EXPOSE 4173
CMD ["node", "server.js"]
