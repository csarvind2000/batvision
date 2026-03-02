FROM node:20-alpine

WORKDIR /app

# if you want pnpm:
RUN corepack enable

COPY package.json package-lock.json ./

# IMPORTANT: you are using package-lock.json (npm lock), not pnpm-lock.yaml
# So either use npm:
RUN npm ci

COPY . .

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
