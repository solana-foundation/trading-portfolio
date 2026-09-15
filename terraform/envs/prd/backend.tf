terraform {
  backend "gcs" {
    bucket = "trading-portfolio-tf-state-prd"
    prefix = "trading-portfolio"
  }
}
