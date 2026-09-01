package terraform.policies.rds

import input as tfplan

# Deny RDS instances that are publicly accessible
deny[msg] {
    resource := tfplan.resource_changes[_]
    resource.type == "aws_db_instance"
    
    # Check if publicly_accessible is set to true
    resource.change.after.publicly_accessible == true
    
    msg := sprintf("SECURITY VIOLATION: RDS instance '%v' must not be publicly accessible", [resource.address])
}

# Deny RDS instances without storage encryption
deny[msg] {
    resource := tfplan.resource_changes[_]
    resource.type == "aws_db_instance"
    
    # If storage_encrypted is false or missing, it evaluates to true for denial
    resource.change.after.storage_encrypted != true
    
    msg := sprintf("COMPLIANCE VIOLATION: RDS instance '%v' must have storage_encrypted set to true", [resource.address])
}

# Restrict allowed instance classes to prevent unexpected costs
allowed_instance_classes = {"db.t3.micro", "db.t3.small"}

deny[msg] {
    resource := tfplan.resource_changes[_]
    resource.type == "aws_db_instance"
    
    instance_class := resource.change.after.instance_class
    not allowed_instance_classes[instance_class]
    
    msg := sprintf("COST VIOLATION: RDS instance '%v' has invalid instance class '%v'. Allowed: %v", [resource.address, instance_class, allowed_instance_classes])
}
