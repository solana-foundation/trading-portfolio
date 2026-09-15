resource "google_cloud_run_v2_service" "api" {
  name     = "trading-portfolio-${var.env}-us"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  deletion_protection = false

  template {
    service_account                  = google_service_account.cloud_run_runtime.email
    timeout                          = "120s"
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.this.connection_name]
      }
    }

    containers {
      # Placeholder; real images are deployed by .github/workflows/deploy.yml.
      image = "us-docker.pkg.dev/cloudrun/container/hello"

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      dynamic "env" {
        for_each = {
          HELIUS_API_KEY  = google_secret_manager_secret.vendor["helius-api-key"].secret_id
          BIRDEYE_API_KEY = google_secret_manager_secret.vendor["birdeye-api-key"].secret_id
          TRITON_API_URL  = google_secret_manager_secret.vendor["triton-api-url"].secret_id
          DATABASE_URL    = google_secret_manager_secret.database_url.secret_id
        }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].containers[0].env,
    ]
  }

  depends_on = [
    google_project_service.this["run.googleapis.com"],
    google_secret_manager_secret_iam_member.vendor_accessor,
    google_secret_manager_secret_iam_member.database_url_accessor,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "allusers_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
