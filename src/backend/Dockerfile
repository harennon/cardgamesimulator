# intermediate image to build project on
FROM node:22.14 AS builder

WORKDIR /usr/src/app

# install dependencies first
COPY ["package.json", "package-lock.json", "./"]
RUN npm ci --ignore-scripts

# build project
COPY . .
RUN npm run build


# base image
FROM node:22.14-alpine
WORKDIR /usr/src/app

# create user
RUN adduser -S -D -h /usr/src/app cgs && chown -R cgs:nogroup .

# copy dependencies and build artifacts
COPY ["package.json", "package-lock.json", "./"]
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/build/backend ./build/backend
COPY --from=builder /usr/src/app/build/shared ./build/shared

# run server
EXPOSE 3000

CMD ["npm", "run", "start:backend-debug"]
