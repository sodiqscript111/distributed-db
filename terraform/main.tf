terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

provider "aws" {
  alias  = "af_south_1"
  region = "af-south-1"
}

provider "aws" {
  alias  = "eu_west_1"
  region = "eu-west-1"
}

locals {
  secret_name = "${var.app_name}/db-credentials"
}

resource "aws_secretsmanager_secret" "db_credentials" {
  provider    = aws.us_east_1
  name        = local.secret_name
  description = "RDS credentials and connection strings for ${var.app_name}"

  tags = {
    Application = var.app_name
  }
}

resource "aws_secretsmanager_secret_version" "db_credentials" {
  provider  = aws.us_east_1
  secret_id = aws_secretsmanager_secret.db_credentials.id

  secret_string = jsonencode({
    username = var.db_username
    password = var.db_password
    nodes = [
      "postgres://${var.db_username}:${var.db_password}@${module.node_us_east_1.db_endpoint}/${var.db_name}",
      "postgres://${var.db_username}:${var.db_password}@${module.node_af_south_1.db_endpoint}/${var.db_name}",
      "postgres://${var.db_username}:${var.db_password}@${module.node_eu_west_1.db_endpoint}/${var.db_name}",
    ]
  })
}

module "node_us_east_1" {
  source    = "./modules/rds_region"
  providers = { aws = aws.us_east_1 }

  region                   = "us-east-1"
  node_index               = 0
  app_name                 = var.app_name
  vpc_cidr                 = var.us_east_1_cidr
  db_name                  = var.db_name
  db_username              = var.db_username
  db_password              = var.db_password
  db_instance_class        = var.db_instance_class
  db_allocated_storage     = var.db_allocated_storage
  db_max_allocated_storage = var.db_max_allocated_storage
  db_engine_version        = var.db_engine_version
  db_backup_retention_days = var.db_backup_retention_days
  allowed_cidr_blocks      = var.allowed_cidr_blocks
  peer_vpc_cidrs           = [var.af_south_1_cidr, var.eu_west_1_cidr]
}

module "node_af_south_1" {
  source    = "./modules/rds_region"
  providers = { aws = aws.af_south_1 }

  region                   = "af-south-1"
  node_index               = 1
  app_name                 = var.app_name
  vpc_cidr                 = var.af_south_1_cidr
  db_name                  = var.db_name
  db_username              = var.db_username
  db_password              = var.db_password
  db_instance_class        = var.db_instance_class
  db_allocated_storage     = var.db_allocated_storage
  db_max_allocated_storage = var.db_max_allocated_storage
  db_engine_version        = var.db_engine_version
  db_backup_retention_days = var.db_backup_retention_days
  allowed_cidr_blocks      = var.allowed_cidr_blocks
  peer_vpc_cidrs           = [var.us_east_1_cidr, var.eu_west_1_cidr]
}

module "node_eu_west_1" {
  source    = "./modules/rds_region"
  providers = { aws = aws.eu_west_1 }

  region                   = "eu-west-1"
  node_index               = 2
  app_name                 = var.app_name
  vpc_cidr                 = var.eu_west_1_cidr
  db_name                  = var.db_name
  db_username              = var.db_username
  db_password              = var.db_password
  db_instance_class        = var.db_instance_class
  db_allocated_storage     = var.db_allocated_storage
  db_max_allocated_storage = var.db_max_allocated_storage
  db_engine_version        = var.db_engine_version
  db_backup_retention_days = var.db_backup_retention_days
  allowed_cidr_blocks      = var.allowed_cidr_blocks
  peer_vpc_cidrs           = [var.us_east_1_cidr, var.af_south_1_cidr]
}
