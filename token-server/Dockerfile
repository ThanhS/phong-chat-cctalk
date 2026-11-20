FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js users.js db.js add-user.js ./
USER node
EXPOSE 3001
CMD ["node", "server.js"]
