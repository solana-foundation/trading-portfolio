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
  ]
}

resource "google_service_account" "invoker" {
  account_id   = "portfolio-invoker-${var.env}"
  display_name = "Portfolio API invoker (${var.env})"
  description  = "Identity internal services use to call the private portfolio API."
}

resource "google_cloud_run_v2_service_iam_member" "invokers" {
  for_each = {
    internal = google_service_account.invoker.email
    deployer = google_service_account.cloudrun_deployer.email
  }

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${each.value}"
}
