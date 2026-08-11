# Sidecar d'extraction audio YouTube : image Playwright officielle (Chromium préinstallé).
FROM mcr.microsoft.com/playwright/python:v1.47.0-jammy

WORKDIR /app
RUN pip install --no-cache-dir "fastapi>=0.111" "uvicorn[standard]>=0.29"
COPY extract.py .

EXPOSE 8080
CMD ["uvicorn", "extract:app", "--host", "0.0.0.0", "--port", "8080"]
