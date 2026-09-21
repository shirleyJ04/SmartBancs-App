FROM python:3.12-slim
WORKDIR /app
COPY etl/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY etl/transform.py /app/transform.py
COPY etl/uafe_catalog.py /app/uafe_catalog.py
COPY testdata /app/testdata
COPY services/ai/sql/init.sql /app/sql/init.sql
ENV AI_SCHEMA_SQL=/app/sql/init.sql
CMD ["python", "/app/transform.py", "--from-db"]
