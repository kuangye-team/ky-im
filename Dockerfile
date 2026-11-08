FROM rust:1.91-bookworm AS backend
WORKDIR /build/api
COPY api/Cargo.toml api/Cargo.lock ./
COPY api/src/ ./src/
RUN cargo build --release --locked

FROM node:22-bookworm-slim AS frontend
WORKDIR /build/ssg
ARG NPM_REGISTRY=https://registry.npmjs.org/
COPY ssg/package*.json ./
RUN npm config set registry "${NPM_REGISTRY}" && npm ci
COPY ssg/ ./
ARG VITE_ROOM=local
ARG VITE_SIGNAL_URL=
ENV VITE_ROOM=$VITE_ROOM VITE_SIGNAL_URL=$VITE_SIGNAL_URL
RUN npm run build

FROM debian:bookworm-slim
RUN groupadd --system send && useradd --system --gid send send
WORKDIR /app
COPY --from=backend /build/api/target/release/server /app/server
COPY --from=frontend /build/ssg/dist /app/static
ENV BIND_ADDR=0.0.0.0:8080 STATIC_DIR=/app/static
USER send
EXPOSE 8080
CMD ["/app/server"]
