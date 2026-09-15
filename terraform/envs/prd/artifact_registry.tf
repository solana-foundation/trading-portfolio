resource "google_artifact_registry_repository" "containers" {
  location      = var.region
  repository_id = "trading-portfolio-${var.env}"
  description   = "Container images for the trading-portfolio Cloud Run service (${var.env})."
  format        = "DOCKER"
  depends_on    = [google_project_service.this["artifactregistry.googleapis.com"]]
}
