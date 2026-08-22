# The real Dockerfile shape. The app inside is a placeholder; the layering,
# the port and the health path are what the rest of the stack depends on.
FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
# The port is configuration, not a constant. Production sets ENGINE_PORT=8080
# and a hard-coded 3000 here fails every health check on a box that is fine.
ENV ENGINE_PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=3 \
  CMD curl -fsS "http://localhost:${ENGINE_PORT}/health" || exit 1
CMD ["python", "app.py"]
