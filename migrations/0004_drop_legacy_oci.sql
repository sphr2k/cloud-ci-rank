-- Keeper does not provide OCI; remove the previous Oracle API snapshot.
DELETE FROM instances WHERE provider = 'OCI';
DELETE FROM sources WHERE provider = 'OCI';
