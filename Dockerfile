# intermediate image to build project on
FROM node:22.14 AS builder

WORKDIR /usr/src/app

# install dependencies first
COPY . .

RUN npm ci

# build project
RUN npm run build


# base image
FROM node:22.14-alpine

WORKDIR /usr/src/app

# create user
RUN adduser -S -D -h /usr/src/app cgs && chown -R cgs:nogroup .

# copy dependencies and build artifacts
COPY ["package.json", "package-lock.json", "./"]

COPY --from=builder /usr/src/app/node_modules ./node_modules

COPY --from=builder /usr/src/app/build ./build

# run server
EXPOSE 8000

CMD ["npm", "run", "start:server"]
