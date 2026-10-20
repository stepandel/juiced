FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY service/package.json service/package.json
RUN npm ci --ignore-scripts --omit=optional --no-audit
COPY service/src service/src
COPY service/scripts service/scripts
COPY service/migrations service/migrations
COPY contracts contracts
USER node
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "--import", "tsx", "service/src/main.ts"]
