# the playground as a container, built from the repository root:
#   docker build -f threads/playground/Dockerfile -t porffor-playground .
#   docker run -p 8787:8787 porffor-playground
# on Railway: set RAILWAY_DOCKERFILE_PATH=threads/playground/Dockerfile ($PORT is honored)

# build: wasi-sdk brings the sysroot, the builtins, clang and wasm-ld that build.js uses
FROM node:24-bookworm-slim AS build
ARG WASI_SDK=34
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN arch=$(uname -m | sed 's/aarch64/arm64/') \
  && curl -fsSL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK}/wasi-sdk-${WASI_SDK}.0-${arch}-linux.tar.gz \
  | tar xz -C /opt && mv /opt/wasi-sdk-${WASI_SDK}.0-${arch}-linux /opt/wasi-sdk
WORKDIR /porffor
COPY compiler compiler
COPY runtime runtime
COPY threads/playground threads/playground
RUN node threads/playground/build.js

# run: just node, the compiler (the page loads it) and the playground with its build
FROM node:24-bookworm-slim
WORKDIR /porffor
COPY --from=build /porffor/compiler compiler
COPY --from=build /porffor/threads/playground threads/playground
ENV PORT=8787
EXPOSE 8787
CMD ["node", "threads/playground/serve.js"]
