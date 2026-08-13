variable "region" {
  description = "AWS region for this module"
  type        = string
}

variable "app_name" {
  description = "Application name prefix for resource naming"
  type        = string
}

variable "node_index" {
  description = "Zero-based index of this node (used for naming: node-0, node-1, node-2)"
  type        = number
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC in this region"
  type        = string
}

variable "db_name" {
  description = "PostgreSQL database name"
  type        = string
}

variable "db_username" {
  description = "PostgreSQL master username"
  type        = string
}

variable "db_password" {
  description = "PostgreSQL master password"
  type        = string
  sensitive   = true
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
}

variable "db_allocated_storage" {
  description = "Initial allocated storage in GB"
  type        = number
}

variable "db_max_allocated_storage" {
  description = "Max autoscaling storage in GB"
  type        = number
}

variable "db_engine_version" {
  description = "PostgreSQL engine version"
  type        = string
}

variable "db_backup_retention_days" {
  description = "Automated backup retention in days"
  type        = number
}

variable "allowed_cidr_blocks" {
  description = "External CIDRs allowed to reach port 5432"
  type        = list(string)
  default     = []
}

variable "peer_vpc_cidrs" {
  description = "CIDRs of peer VPCs to allow through the security group"
  type        = list(string)
  default     = []
}
