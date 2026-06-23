FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json? pnpm-lock.yaml? ./

RUN npm install

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev"]