resource "random_password" "app_user" {
  length           = 32
  special          = true
  override_special = "_-"
}

# ponytail: public-IP instance reached only through the Cloud SQL connector
# (no authorized networks); move to private VPC like tokens if required.
resource "google_sql_database_instance" "this" {
  name                = "trading-portfolio-${var.env}"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = true
  depends_on          = [google_project_service.this["sqladmin.googleapis.com"]]

  settings {
    edition           = "ENTERPRISE"
    tier              = "db-g1-small"
    availability_type = "ZONAL"
    disk_size         = 10
    disk_type         = "PD_SSD"
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "02:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 30
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day          = 7
      hour         = 3
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = true
      query_string_length     = 1024
      record_application_tags = true
      record_client_address   = false
    }

    database_flags {
      name  = "log_statement"
      value = "ddl"
    }
  }
}

resource "google_sql_database" "portfolio" {
  name     = "portfolio"
  instance = google_sql_database_instance.this.name
}

resource "google_sql_user" "app" {
  name     = "portfolio_app"
  instance = google_sql_database_instance.this.name
  password = random_password.app_user.result
}
