FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json? pnpm-lock.yaml? ./

RUN npm install

COPY . .

# Create .env file from environment variables at runtime
CMD ["sh", "-c", "echo \"VITE_BACKEND_URL=${VITE_BACKEND_URL}\" > .env && echo \"VITE_AGENT_URL=${VITE_AGENT_URL}\" >> .env && npm run dev"]

EXPOSE 5173