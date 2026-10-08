-- PLC and the PDS share the stack's Postgres, each in its own database.
SELECT 'CREATE DATABASE plc' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'plc')\gexec
SELECT 'CREATE DATABASE pds' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'pds')\gexec
