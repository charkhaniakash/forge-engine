FROM python:3.11-slim

WORKDIR /app

# Install uv
RUN pip install uv

# Copy project metadata
COPY pyproject.toml .

# Copy source code
COPY src ./src

# Install project and dependencies
RUN uv pip install --system -e .

EXPOSE 8000

CMD ["python", "-m", "src.main"]