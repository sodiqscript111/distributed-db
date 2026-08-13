variable "app_name" {
  description = "Application name prefix used for all AWS resource names"
  type        = string
  default     = "distributed-db"
}

variable "db_name" {
  description = "PostgreSQL database name created on each RDS instance"
  type        = string
  default     = "distributed_db"
}

variable "db_username" {
  description = "Master username for all RDS instances"
  type        = string
  default     = "postgres"
}

variable "db_password" {
  description = "Master password for all RDS instances. Must be at least 8 characters."
  type        = string
  sensitive   = true
}

variable "db_instance_class" {
  description = "RDS instance class. db.r6g.large is Graviton2 production-grade."
  type        = string
  default     = "db.r6g.large"
}

variable "db_allocated_storage" {
  description = "Allocated storage in GB for each RDS instance"
  type        = number
  default     = 100
}

variable "db_max_allocated_storage" {
  description = "Maximum storage autoscaling ceiling in GB"
  type        = number
  default     = 500
}

variable "db_engine_version" {
  description = "PostgreSQL engine version"
  type        = string
  default     = "16.3"
}

variable "db_backup_retention_days" {
  description = "Number of days to retain automated backups"
  type        = number
  default     = 7
}

variable "allowed_cidr_blocks" {
  description = "List of CIDR blocks allowed to connect to RDS on port 5432 (your app server IPs)"
  type        = list(string)
  default     = []
}

variable "us_east_1_cidr" {
  description = "VPC CIDR block for us-east-1"
  type        = string
  default     = "10.0.0.0/16"
}

variable "af_south_1_cidr" {
  description = "VPC CIDR block for af-south-1"
  type        = string
  default     = "10.1.0.0/16"
}

variable "eu_west_1_cidr" {
  description = "VPC CIDR block for eu-west-1"
  type        = string
  default     = "10.2.0.0/16"
}
