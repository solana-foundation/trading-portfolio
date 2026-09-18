# Rollback

**Infrastructure ordering** — apply `terraform/envs/prd` before pushing a deploy that depends on it. The deploy workflow's migration job attaches VPC settings only once the terraform-created subnet exists; deploying network-dependent changes before the apply blocks the release at the migration step. After an apply, verify with a deploy (or workflow re-run) and confirm the smoke gate passes.

**Service** — route traffic back to a previous Cloud Run revision (no rebuild):

```
gcloud run revisions list --service=<SERVICE> --region=<REGION>
gcloud run services update-traffic <SERVICE> --region=<REGION> --to-revisions=<GOOD_REVISION>=100
```

**Migrations** — forward-fix only. Each file in `db/migrations/` runs in a single transaction (`db/apply.sh`), so a failed migration leaves the schema untouched and the deploy stops before rollout: fix the SQL and re-push. Never hand-edit `schema_migrations`; to undo an applied migration, ship a new down-migration file. Keep migrations additive (add first, drop in a later release) so the previous revision stays compatible during a rollback. Point-in-time recovery is enabled on the database for data-level incidents.
