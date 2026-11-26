FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PORT=8001

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY segmenter.py app.py ./

EXPOSE 8001
# Model weights download on first start into ~/.cache/huggingface (mounted as a volume in docker-compose).
CMD ["python", "app.py"]
