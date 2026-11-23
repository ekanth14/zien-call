FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .
ENV NODE_ENV=production DATA_DIR=/data NODE_OPTIONS=--max-old-space-size=160
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
