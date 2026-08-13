output "secret_arn" {
  description = "ARN of the Secrets Manager secret containing all DB credentials and node connection strings"
  value       = aws_secretsmanager_secret.db_credentials.arn
}

output "secret_name" {
  description = "Name of the Secrets Manager secret"
  value       = aws_secretsmanager_secret.db_credentials.name
}

output "node_us_east_1" {
  description = "us-east-1 (node-0) RDS connection details"
  value = {
    instance_id = module.node_us_east_1.db_instance_id
    host        = module.node_us_east_1.db_host
    port        = module.node_us_east_1.db_port
    db_name     = module.node_us_east_1.db_name
    endpoint    = module.node_us_east_1.db_endpoint
    vpc_id      = module.node_us_east_1.vpc_id
  }
}

output "node_af_south_1" {
  description = "af-south-1 (node-1) RDS connection details"
  value = {
    instance_id = module.node_af_south_1.db_instance_id
    host        = module.node_af_south_1.db_host
    port        = module.node_af_south_1.db_port
    db_name     = module.node_af_south_1.db_name
    endpoint    = module.node_af_south_1.db_endpoint
    vpc_id      = module.node_af_south_1.vpc_id
  }
}

output "node_eu_west_1" {
  description = "eu-west-1 (node-2) RDS connection details"
  value = {
    instance_id = module.node_eu_west_1.db_instance_id
    host        = module.node_eu_west_1.db_host
    port        = module.node_eu_west_1.db_port
    db_name     = module.node_eu_west_1.db_name
    endpoint    = module.node_eu_west_1.db_endpoint
    vpc_id      = module.node_eu_west_1.vpc_id
  }
}

output "usage_instructions" {
  description = "How to configure the app to use these nodes"
  value       = <<-EOT
    App startup with Secrets Manager:
      export AWS_REGION=us-east-1
      export SECRET_NAME=${aws_secretsmanager_secret.db_credentials.name}
      npm run dev

    The app will automatically fetch node connection strings from Secrets Manager at startup.
  EOT
}
