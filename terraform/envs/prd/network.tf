resource "google_compute_network" "vpc" {
  name                    = "trading-portfolio-${var.env}"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.this["compute.googleapis.com"]]
}

resource "google_compute_subnetwork" "cloud_run" {
  name                     = "trading-portfolio-${var.env}"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = "10.10.0.0/24"
  private_ip_google_access = true
}

resource "google_compute_global_address" "private_service_access" {
  name          = "trading-portfolio-${var.env}-psa"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private_service_access" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_service_access.name]
  depends_on              = [google_project_service.this["servicenetworking.googleapis.com"]]
}
