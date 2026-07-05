# forge-sandbox-go:latest
# Base sandbox image + Go toolchain for Phase 8 validation.
# Profile: go_default_v1
# Includes: git, go, golangci-lint (optional)

FROM forge-sandbox:latest

USER root

# Install Go — pin to a specific version for reproducibility.
ARG GO_VERSION=1.22.4
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN wget -q "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -O /tmp/go.tar.gz \
    && tar -C /usr/local -xzf /tmp/go.tar.gz \
    && rm /tmp/go.tar.gz

ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH="/home/forge/go"
ENV GOMODCACHE="/home/forge/go/pkg/mod"

RUN mkdir -p /home/forge/go && chown -R forge:forge /home/forge/go

# golangci-lint is optional (profile marks it Optional=true).
# Install a pinned version so the sandbox image is reproducible.
ARG GOLANGCI_VERSION=1.59.1
RUN wget -q "https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI_VERSION}/golangci-lint-${GOLANGCI_VERSION}-linux-amd64.tar.gz" \
        -O /tmp/golangci.tar.gz \
    && tar -xzf /tmp/golangci.tar.gz -C /tmp \
    && mv /tmp/golangci-lint-${GOLANGCI_VERSION}-linux-amd64/golangci-lint /usr/local/bin/ \
    && rm -rf /tmp/golangci* \
    && chmod +x /usr/local/bin/golangci-lint

USER forge
WORKDIR /workspace
CMD ["sleep", "infinity"]
