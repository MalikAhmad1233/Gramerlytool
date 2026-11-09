# WriteMind API (FastAPI). Build context: repository root.
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN useradd --system --uid 10001 writemind
WORKDIR /app
COPY backend/pyproject.toml ./
RUN pip install --upgrade pip && pip install .
COPY backend/ ./
USER writemind
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://localhost:8000/health'); sys.exit(0)"
# Apply migrations, then serve. Workers share nothing but PostgreSQL (rate limits/cache are per worker).
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY:-2} --proxy-headers --forwarded-allow-ips='*'"]
