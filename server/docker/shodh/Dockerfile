# Shodh Memory Server
# Thin wrapper around the official image to handle volume permission migration
# Pinned by tag AND digest. `:latest` lets whatever is pushed next become our base
# image without anyone choosing it, and it is not even reliably the newest — the
# tag can lag. The digest is the half that actually binds: a tag can be re-pushed,
# a digest cannot. 0.2.0 is the same version the add-on builds Shodh from, so dev
# and production stay on one release.
FROM varunshodh/shodh-memory:0.2.0@sha256:90047c1fd48181d49465dc4509a9d2006ef75616f7c7df276f25f3d399ddd51f

USER root
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["shodh-memory"]
