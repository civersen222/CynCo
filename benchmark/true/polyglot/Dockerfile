# benchmark/true/polyglot/Dockerfile
# Test-toolchain image for the aider polyglot benchmark. The agent never runs
# in here — only the hidden-test commands do. Toolchain versions are whatever
# Ubuntu 24.04 / NodeSource 22 / rustup pin below resolve to; record the
# actual versions in the README when the image is built.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git bash \
    python3 python3-pytest \
    golang-go \
    openjdk-21-jdk-headless \
    cmake g++ make \
    && rm -rf /var/lib/apt/lists/*
# Node 22 (exercism JS needs jest 29 -> node >= 18)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
# Rust via rustup, pinned for reproducibility
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain 1.83.0 --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"
WORKDIR /bench
CMD ["sleep", "infinity"]
