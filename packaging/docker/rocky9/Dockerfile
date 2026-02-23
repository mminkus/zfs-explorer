FROM rockylinux:9

ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:${PATH}

RUN dnf -y install dnf-plugins-core \
    && dnf config-manager --set-enabled crb \
    && dnf -y install \
    ca-certificates \
    curl-minimal \
    git \
    gcc \
    gcc-c++ \
    make \
    autoconf \
    automake \
    libtool \
    pkgconf-pkg-config \
    m4 \
    gawk \
    openssl-devel \
    elfutils-libelf-devel \
    systemd-devel \
    libuuid-devel \
    libblkid-devel \
    zlib-devel \
    libzstd-devel \
    libtirpc-devel \
    clang \
    clang-devel \
    python3 \
    python3-pip \
    python3-setuptools \
    python3-cffi \
    libffi-devel \
    rsync \
    jq \
    ksh \
    xz \
    findutils \
    which \
    diffutils \
    tar \
    gzip \
    && dnf clean all

RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
    && chmod -R a+rX "${RUSTUP_HOME}" "${CARGO_HOME}"

WORKDIR /workspace
