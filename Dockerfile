# syntax=docker/dockerfile:1

FROM rust:1.91-bookworm AS backend
WORKDIR /build/api
COPY api/Cargo.toml api/Cargo.lock ./
COPY api/src/ ./src/
COPY shared/ /build/shared/
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
ARG VITE_ROOM=local
ARG VITE_SIGNAL_URL=
ARG VITE_API_AUTH=
ARG VITE_STORAGE_CHUNK_SIZE=2097152
ENV VITE_ROOM=$VITE_ROOM VITE_SIGNAL_URL=$VITE_SIGNAL_URL VITE_API_AUTH=$VITE_API_AUTH VITE_STORAGE_CHUNK_SIZE=$VITE_STORAGE_CHUNK_SIZE
RUN npm run build

FROM debian:bookworm-slim
RUN groupadd --system send && useradd --system --gid send send
WORKDIR /app
COPY --from=backend /build/server /app/server
COPY --from=frontend /build/ssg/dist /app/static
ENV BIND_ADDR=0.0.0.0:8080 STATIC_DIR=/app/static
USER send
EXPOSE 8080
CMD ["/app/server"]
