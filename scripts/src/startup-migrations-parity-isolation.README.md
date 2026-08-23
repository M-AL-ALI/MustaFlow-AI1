# Startup-migrations parity isolation

This runner replaces any temptation to execute the retired broad stability profile for a migration-parity check.

## Two-phase law

- Phase 1 is lab-only. Unit tests inject fake connectors and never open a database.
- Phase 2's first live run happens only under an explicit desk block, against the desk-named scratch database on the development host.

Run Phase 2 only by setting `PARITY_TEST_DATABASE_URL` to a PostgreSQL URL whose database name matches `parity_scratch` or `parity_scratch_<lowercase-alphanumeric>`, then invoke:

```text
pnpm --filter @workspace/scripts exec node --import tsx src/startup-migrations-parity-isolation.ts
```

Ambient `DATABASE_URL` does not enable the runner and is not forwarded. The validated scratch URL is passed to one isolated child that runs only the existing startup-migrations parity test. The broad stability profile is never invoked. Connection-related output names only the host and database name; it never prints credentials.
