# forge-sandbox:latest
# Minimal base image for task execution workspaces.
#
# Design principles:
#   - Non-root execution: all user commands run as uid 1000 (forge).
#   - No language runtimes: Phase 8 adds per-stack images or installs
#     runtimes at runtime. This image only provides git + shell utilities.
#   - Read-only root (except /workspace and /tmp): enforced at container
#     creation time by the DockerDriver (--read-only flag + tmpfs mounts).
#   - No network access: Docker is started with --network none. Git clone
#     is performed by the backend before the network is disabled.

FROM ubuntu:22.04

# Disable interactive prompts during package installation.
ENV DEBIAN_FRONTEND=noninteractive

# Install only what is strictly necessary.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Create the forge user (uid/gid 1000). All sandboxed commands run as this user.
RUN groupadd --gid 1000 forge \
 && useradd --uid 1000 --gid forge --shell /bin/bash --create-home forge

# /workspace is the root of every cloned repository.
# The backend mounts a Docker volume here and this directory must be
# owned by the forge user so git clone can write into it.
RUN mkdir -p /workspace && chown forge:forge /workspace

# Configure git to trust /workspace (required by newer git safe.directory checks).
RUN git config --system safe.directory /workspace

# The container runs a long-lived idle process so the DockerDriver can
# issue multiple docker exec calls without re-provisioning. The backend
# is responsible for sending SIGTERM when the workspace is destroyed.
USER forge
WORKDIR /workspace

# Idle process — keeps the container alive between docker exec calls.
# The backend kills the container via docker stop/rm, not by exiting this process.
CMD ["sleep", "infinity"]
