FROM node:22-slim
ENV NODE_ENV=production TZ=Asia/Jerusalem DATA_DIR=/data
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
