terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  node_name = "${var.app_name}-node-${var.node_index}"
  azs       = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name        = "${local.node_name}-vpc"
    Application = var.app_name
    Region      = var.region
    NodeIndex   = var.node_index
  }
}

resource "aws_subnet" "db" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 1)
  availability_zone = local.azs[count.index]

  tags = {
    Name        = "${local.node_name}-subnet-${count.index}"
    Application = var.app_name
  }
}

resource "aws_db_subnet_group" "main" {
  name        = "${local.node_name}-subnet-group"
  description = "DB subnet group for ${local.node_name}"
  subnet_ids  = aws_subnet.db[*].id

  tags = {
    Name        = "${local.node_name}-subnet-group"
    Application = var.app_name
  }
}

resource "aws_security_group" "rds" {
  name        = "${local.node_name}-rds-sg"
  description = "Security group for ${local.node_name} RDS instance"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name        = "${local.node_name}-rds-sg"
    Application = var.app_name
  }
}

resource "aws_security_group_rule" "rds_ingress_app" {
  count             = length(var.allowed_cidr_blocks) > 0 ? 1 : 0
  type              = "ingress"
  from_port         = 5432
  to_port           = 5432
  protocol          = "tcp"
  cidr_blocks       = var.allowed_cidr_blocks
  security_group_id = aws_security_group.rds.id
  description       = "Allow app servers to connect to PostgreSQL"
}

resource "aws_security_group_rule" "rds_ingress_peers" {
  count             = length(var.peer_vpc_cidrs) > 0 ? 1 : 0
  type              = "ingress"
  from_port         = 5432
  to_port           = 5432
  protocol          = "tcp"
  cidr_blocks       = var.peer_vpc_cidrs
  security_group_id = aws_security_group.rds.id
  description       = "Allow cross-region peer VPCs to connect"
}

resource "aws_security_group_rule" "rds_egress" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.rds.id
  description       = "Allow all outbound traffic"
}

resource "aws_db_parameter_group" "main" {
  name        = "${local.node_name}-pg16"
  family      = "postgres16"
  description = "Custom parameter group for ${local.node_name}"

  parameter {
    name  = "max_connections"
    value = "500"
  }

  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "30000"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  parameter {
    name  = "shared_preload_libraries"
    value = "pg_stat_statements"
  }

  tags = {
    Name        = "${local.node_name}-pg16"
    Application = var.app_name
  }
}

resource "aws_db_instance" "main" {
  identifier     = local.node_name
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  db_name  = var.db_name
  username = var.db_username
  password = var.db_password

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.main.name

  backup_retention_period  = var.db_backup_retention_days
  backup_window            = "03:00-04:00"
  maintenance_window       = "Mon:04:00-Mon:05:00"
  copy_tags_to_snapshot    = true
  deletion_protection      = true
  skip_final_snapshot      = false
  final_snapshot_identifier = "${local.node_name}-final-snapshot"

  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  auto_minor_version_upgrade = true
  publicly_accessible        = false
  multi_az                   = true

  tags = {
    Name        = local.node_name
    Application = var.app_name
    Region      = var.region
    NodeIndex   = var.node_index
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${local.node_name}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
    }]
  })

  tags = {
    Application = var.app_name
  }
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name        = "${local.node_name}-igw"
    Application = var.app_name
  }
}

resource "aws_route_table" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name        = "${local.node_name}-rt"
    Application = var.app_name
  }
}

resource "aws_route_table_association" "main" {
  count          = 2
  subnet_id      = aws_subnet.db[count.index].id
  route_table_id = aws_route_table.main.id
}
