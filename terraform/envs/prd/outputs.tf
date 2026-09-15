output "wif_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}

output "cloudrun_deployer_sa_email" {
  value = google_service_account.cloudrun_deployer.email
}

output "cloud_run_runtime_sa_email" {
  value = google_service_account.cloud_run_runtime.email
}

output "artifact_registry_url" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.containers.repository_id}"
}

output "cloud_run_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "cloud_sql_connection_name" {
  value = google_sql_database_instance.this.connection_name
}

output "cloud_sql_app_password" {
  value     = random_password.app_user.result
  sensitive = true
}

output "database_url_secret_id" {
  value = google_secret_manager_secret.database_url.secret_id
}
