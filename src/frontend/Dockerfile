# intermediate image to build project on
FROM node:22.14 AS builder

WORKDIR /usr/src/app

# install dependencies first
COPY ["package.json", "package-lock.json", "./"]
RUN npm ci --ignore-scripts

# build project
COPY . .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_BASE_URL
RUN npm run build


# base image
FROM nginx:stable-alpine
WORKDIR /usr/src/app

# create user
RUN adduser -S -D -h /usr/src/app cgs && chown -R cgs:nogroup .

# copy dependencies and build artifacts
COPY ["package.json", "package-lock.json", "./"]
COPY ./src/frontend/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=builder /usr/src/app/build/frontend /usr/share/nginx/html

# run server
EXPOSE 80

CMD [ "nginx", "-g", "daemon off;" ]
