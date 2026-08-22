FROM litestream/litestream:0.3
RUN apk add --no-cache bash sqlite
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["backup"]
