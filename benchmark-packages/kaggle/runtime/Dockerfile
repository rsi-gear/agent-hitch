# Build this recipe once, publish it, and pass its platform manifest digest to import.mjs.
# BASE must be a digest-pinned Python >=3.10 Debian image with Node >=22 and the
# fixed DSH carrier's runtime prerequisites. Downloads happen at image build,
# never inside a task. The task/verifier use this image by immutable digest.
ARG BASE
FROM ${BASE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libseccomp2 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /opt/kaggle-requirements.txt
RUN python3 -m pip install --no-cache-dir -r /opt/kaggle-requirements.txt
# The fixed supervisor copies this root-owned template into a private worker
# root. Never include /proc, /work, credentials, dataset files, or /output here.
# Numeric libraries and Python live under /usr; the loader uses /lib links.
RUN mkdir -p /opt/kaggle-runtime/etc && cp -a /usr /opt/kaggle-runtime/usr \
    && for item in /lib /lib64 /bin; do if [ -e "$item" ]; then cp -a "$item" /opt/kaggle-runtime/; fi; done \
    && if [ -f /etc/ld.so.cache ]; then cp /etc/ld.so.cache /opt/kaggle-runtime/etc/; fi \
    && chmod -R go-w /opt/kaggle-runtime
ENV PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
