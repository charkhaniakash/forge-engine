FROM python:3.11-slim

WORKDIR /app

# Install uv for fast dependency installation
RUN pip install uv

# Copy pyproject.toml
COPY pyproject.toml .

# Install dependencies
RUN uv pip install --system-site-packages -r <(uv pip compile pyproject.toml)

# Copy source
COPY src src

EXPOSE 8000
CMD ["python", "-m", "src.main"]