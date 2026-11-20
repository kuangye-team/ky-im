# syntax=docker/dockerfile:1

FROM rust:1.91-bookworm AS backend
WORKDIR /build/api
ARG RELEASE_VERSION=0.1.0
ENV RELEASE_VERSION=$RELEASE_VERSION
COPY shared/ /build/shared/
COPY api/Cargo.toml api/Cargo.lock api/build.rs ./
COPY api/src/ ./src/
ARG TARGETPLATFORM
# Refresh crate roots so older COPY timestamps cannot reuse stale app binaries.
# Keep the server outside the cache mount for the final stage and CI layer cache.
RUN --mount=type=cache,id=ky-im-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=ky-im-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=ky-im-cargo-target-${TARGETPLATFORM},target=/build/api/target,sharing=locked \
    touch src/lib.rs src/main.rs \
    && cargo build --release --locked \
    && cp target/release/server /build/server

FROM node:22-bookworm-slim AS frontend
WORKDIR /build/ssg
ARG NPM_REGISTRY=https://registry.npmjs.org/
COPY ssg/package*.json ./
RUN --mount=type=cache,id=ky-im-npm,target=/root/.npm,sharing=locked \
    npm config set registry "${NPM_REGISTRY}" && npm ci --prefer-offline --verbose
COPY ssg/ ./
COPY shared/ /build/shared/
ARG RELEASE_VERSION=0.1.0
ENV RELEASE_VERSION=$RELEASE_VERSION
ARG VITE_PEER_CHECK_INTERVAL_MS=10000
ENV VITE_PEER_CHECK_INTERVAL_MS=$VITE_PEER_CHECK_INTERVAL_MS
ARG VITE_ROOM=local
ARG VITE_ICE_SERVERS=stun:stun.miwifi.com:3478,stun:stun.chat.bilibili.com:3478,stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302
ENV VITE_ICE_SERVERS=$VITE_ICE_SERVERS
ARG VITE_SIGNAL_URL=
ARG VITE_API_LATEST=/api/latest
ENV VITE_API_LATEST=$VITE_API_LATEST
ARG VITE_API_AUTH=
ARG VITE_WEB_URL=https://im.kuangye.team/
ARG VITE_CLIENT_DOWNLOAD_URL=https://github.com/kuangye-team/ky-im/releases/latest
ENV VITE_WEB_URL=$VITE_WEB_URL VITE_CLIENT_DOWNLOAD_URL=$VITE_CLIENT_DOWNLOAD_URL
ARG VITE_SHOW_TRANSFER_SPEED=true
ENV VITE_SHOW_TRANSFER_SPEED=$VITE_SHOW_TRANSFER_SPEED
ARG VITE_RTC_MAX_MESSAGE_SIZE=65536
ENV VITE_RTC_MAX_MESSAGE_SIZE=$VITE_RTC_MAX_MESSAGE_SIZE
ARG VITE_RTC_MAX_BUFFERED_AMOUNT=1048576
ENV VITE_RTC_MAX_BUFFERED_AMOUNT=$VITE_RTC_MAX_BUFFERED_AMOUNT
ARG VITE_RTC_BUFFERED_AMOUNT_LOW_THRESHOLD=262144
ENV VITE_RTC_BUFFERED_AMOUNT_LOW_THRESHOLD=$VITE_RTC_BUFFERED_AMOUNT_LOW_THRESHOLD
ARG VITE_RTC_FILE_CHUNK_SIZE=262144
ENV VITE_RTC_FILE_CHUNK_SIZE=$VITE_RTC_FILE_CHUNK_SIZE
ARG VITE_STORAGE_CHUNK_SIZE=2097152
ENV VITE_ROOM=$VITE_ROOM VITE_SIGNAL_URL=$VITE_SIGNAL_URL VITE_API_AUTH=$VITE_API_AUTH VITE_STORAGE_CHUNK_SIZE=$VITE_STORAGE_CHUNK_SIZE
RUN npm run build

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /build/server /app/server
COPY --from=frontend /build/ssg/dist /app/static
ENV BIND_ADDR=0.0.0.0:8080 STATIC_DIR=/app/static
RUN chown -R 1000:1000 /app
USER 1000:1000
EXPOSE 8080
CMD ["/app/server"]
