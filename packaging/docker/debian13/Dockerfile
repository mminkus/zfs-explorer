FROM debian:13

ENV DEBIAN_FRONTEND=noninteractive
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    build-essential \
    autoconf \
    automake \
    libtool \
    pkg-config \
    m4 \
    gawk \
    libssl-dev \
    libelf-dev \
    libudev-dev \
    libblkid-dev \
    uuid-dev \
    zlib1g-dev \
    libzstd-dev \
    libtirpc-dev \
    clang \
    libclang-dev \
    python3 \
    python3-pip \
    python3-setuptools \
    python3-cffi \
    libffi-dev \
    rsync \
    jq \
    ksh \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
    && chmod -R a+rX "${RUSTUP_HOME}" "${CARGO_HOME}"

WORKDIR /workspace
