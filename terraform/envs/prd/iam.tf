resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-${var.env}"
  display_name              = "GitHub Actions (${var.env})"
  description               = "OIDC pool for GitHub Actions running against ${var.env}."
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    "attribute.actor"      = "assertion.actor"
  }

  attribute_condition = "assertion.repository == \"${var.github_repo}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "cloud_run_runtime" {
  account_id   = "cr-runtime-${var.env}"
  display_name = "Cloud Run runtime (${var.env})"
  description  = "Identity for the trading-portfolio Cloud Run service."
}

resource "google_project_iam_member" "cloud_run_runtime_roles" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.cloud_run_runtime.email}"
}

resource "google_project_iam_member" "grafana_gcm_reader" {
  project = var.project_id
  role    = "roles/monitoring.viewer"
  member  = "serviceAccount:grafana-gcm-reader@solana-earn.iam.gserviceaccount.com"
}

resource "google_service_account" "cloudrun_deployer" {
  account_id   = "cr-deployer-${var.env}"
  display_name = "Cloud Run deployer (${var.env})"
  description  = "GH Actions assumes via WIF on main only — deploys Cloud Run revisions."
}

resource "google_project_iam_member" "cloudrun_deployer_roles" {
  for_each = toset([
    "roles/run.admin",
    "roles/cloudsql.client",
    "roles/artifactregistry.writer",
    "roles/iam.serviceAccountUser",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.cloudrun_deployer.email}"
}

resource "google_service_account_iam_member" "cloudrun_deployer_wif_binding" {
  service_account_id = google_service_account.cloudrun_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.ref/refs/heads/main"
}
