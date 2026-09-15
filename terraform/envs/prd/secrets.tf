locals {
  runtime_secrets = [
    "helius-api-key",
    "birdeye-api-key",
    "triton-api-url",
    "database-url",
  ]
}

resource "google_secret_manager_secret" "runtime" {
  for_each  = toset(local.runtime_secrets)
  project   = var.project_id
  secret_id = "trading-portfolio-${each.value}-${var.env}"

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.this["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_iam_member" "runtime_accessor" {
  for_each  = google_secret_manager_secret.runtime
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run_runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "deployer_version_adder" {
  for_each  = google_secret_manager_secret.runtime
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${google_service_account.cloudrun_deployer.email}"
}

resource "google_secret_manager_secret_iam_member" "deployer_accessor" {
  for_each  = google_secret_manager_secret.runtime
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloudrun_deployer.email}"
}
