-- Runs once on a fresh Postgres data volume (docker-entrypoint-initdb.d).
CREATE DATABASE jungle_test OWNER jungle;
CREATE DATABASE jungle_test_mig OWNER jungle;
CREATE DATABASE jungle_test_multi OWNER jungle;
