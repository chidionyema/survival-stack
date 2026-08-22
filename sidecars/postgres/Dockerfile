FROM postgres:16-alpine
ARG WALG_VERSION=v3.0.5
RUN apk add --no-cache bash curl ca-certificates \
 && curl -fsSL -o /usr/local/bin/wal-g \
    "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-ubuntu-20.04-amd64" \
 && chmod +x /usr/local/bin/wal-g
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["backup"]
