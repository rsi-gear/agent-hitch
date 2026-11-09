# Build once and import by manifest digest. The selected ordinary agent harness
# supplies its own Node/model runtime. No fixed training carrier is installed.
ARG BASE
FROM ${BASE}
COPY requirements.txt /opt/mlebench-requirements.txt
RUN python3 -m pip install --no-cache-dir -r /opt/mlebench-requirements.txt
ENV PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
