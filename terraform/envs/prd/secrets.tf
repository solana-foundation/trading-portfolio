resource "google_secret_manager_secret" "vendor" {
  for_each = toset([
    "helius-api-key",
    "birdeye-api-key",
    "triton-api-url",
  ])

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

resource "google_secret_manager_secret_version" "vendor_initial" {
  for_each = google_secret_manager_secret.vendor

  secret      = each.value.id
  secret_data = ""

  lifecycle {
    ignore_changes = [secret_data, secret_data_wo_version]
  }
}

resource "google_secret_manager_secret_iam_member" "vendor_accessor" {
  for_each = google_secret_manager_secret.vendor

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run_runtime.email}"
}

resource "google_secret_manager_secret" "database_url" {
  project   = var.project_id
  secret_id = "trading-portfolio-database-url-${var.env}"

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.this["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgresql://${google_sql_user.app.name}:${random_password.app_user.result}@localhost/${google_sql_database.portfolio.name}?host=/cloudsql/${google_sql_database_instance.this.connection_name}"
}

resource "google_secret_manager_secret_iam_member" "database_url_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run_runtime.email}"
}
