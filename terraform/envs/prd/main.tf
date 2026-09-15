import {
  to = google_secret_manager_secret_version.vendor_initial["helius-api-key"]
  id = "projects/trading-portfolio-104696/secrets/trading-portfolio-helius-api-key-prd/versions/1"
}

import {
  to = google_secret_manager_secret_version.vendor_initial["birdeye-api-key"]
  id = "projects/trading-portfolio-104696/secrets/trading-portfolio-birdeye-api-key-prd/versions/1"
}

import {
  to = google_secret_manager_secret_version.vendor_initial["triton-api-url"]
  id = "projects/trading-portfolio-104696/secrets/trading-portfolio-triton-api-url-prd/versions/1"
}

locals {
  services = [
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
  ]
}

resource "google_project_service" "this" {
  for_each = toset(local.services)

  project = var.project_id
  service = each.value

  disable_on_destroy         = false
  disable_dependent_services = false
}
