# The real Dockerfile shape. The app inside is a placeholder; the layering,
# the port and the health path are what the rest of the stack depends on.
FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1
CMD ["python", "app.py"]
