variable "project_id" {
  type        = string
  description = "GCP project hosting the trading-portfolio API."
  default     = "trading-portfolio-104696"
}

variable "region" {
  type        = string
  description = "Primary GCP region for all regional resources."
  default     = "us-east4"
}

variable "env" {
  type        = string
  description = "Environment name (dev / stg / prd)."
  default     = "prd"
}

variable "github_repo" {
  type        = string
  description = "GitHub repo allowed to assume the deployer via WIF."
  default     = "solana-foundation/trading-portfolio"
}

variable "gateway_invokers" {
  type        = map(string)
  description = "API gateway service accounts allowed to invoke the service, keyed by a stable name. Each one forwards a signed X-SF-Identity that the app verifies when the gateway path is on."
  default = {
    gateway_stg = "sf-gw-stg-gateway@gateway-stg.iam.gserviceaccount.com"
  }
}
