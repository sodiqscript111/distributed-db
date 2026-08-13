locals {
  peering_pairs = [
    {
      name         = "us-east-1-to-af-south-1"
      requester    = "us_east_1"
      accepter     = "af_south_1"
      requester_rt = module.node_us_east_1.route_table_id
      accepter_rt  = module.node_af_south_1.route_table_id
      requester_vpc = module.node_us_east_1.vpc_id
      accepter_vpc  = module.node_af_south_1.vpc_id
      requester_cidr = var.us_east_1_cidr
      accepter_cidr  = var.af_south_1_cidr
    },
    {
      name         = "us-east-1-to-eu-west-1"
      requester    = "us_east_1"
      accepter     = "eu_west_1"
      requester_rt = module.node_us_east_1.route_table_id
      accepter_rt  = module.node_eu_west_1.route_table_id
      requester_vpc = module.node_us_east_1.vpc_id
      accepter_vpc  = module.node_eu_west_1.vpc_id
      requester_cidr = var.us_east_1_cidr
      accepter_cidr  = var.eu_west_1_cidr
    },
    {
      name         = "af-south-1-to-eu-west-1"
      requester    = "af_south_1"
      accepter     = "eu_west_1"
      requester_rt = module.node_af_south_1.route_table_id
      accepter_rt  = module.node_eu_west_1.route_table_id
      requester_vpc = module.node_af_south_1.vpc_id
      accepter_vpc  = module.node_eu_west_1.vpc_id
      requester_cidr = var.af_south_1_cidr
      accepter_cidr  = var.eu_west_1_cidr
    },
  ]
}

resource "aws_vpc_peering_connection" "us_east_1_to_af_south_1" {
  provider    = aws.us_east_1
  vpc_id      = module.node_us_east_1.vpc_id
  peer_vpc_id = module.node_af_south_1.vpc_id
  peer_region = "af-south-1"
  auto_accept = false

  tags = {
    Name        = "${var.app_name}-us-east-1-to-af-south-1"
    Application = var.app_name
  }
}

resource "aws_vpc_peering_connection_accepter" "us_east_1_to_af_south_1" {
  provider                  = aws.af_south_1
  vpc_peering_connection_id = aws_vpc_peering_connection.us_east_1_to_af_south_1.id
  auto_accept               = true

  tags = {
    Name        = "${var.app_name}-us-east-1-to-af-south-1-accepter"
    Application = var.app_name
  }
}

resource "aws_vpc_peering_connection" "us_east_1_to_eu_west_1" {
  provider    = aws.us_east_1
  vpc_id      = module.node_us_east_1.vpc_id
  peer_vpc_id = module.node_eu_west_1.vpc_id
  peer_region = "eu-west-1"
  auto_accept = false

  tags = {
    Name        = "${var.app_name}-us-east-1-to-eu-west-1"
    Application = var.app_name
  }
}

resource "aws_vpc_peering_connection_accepter" "us_east_1_to_eu_west_1" {
  provider                  = aws.eu_west_1
  vpc_peering_connection_id = aws_vpc_peering_connection.us_east_1_to_eu_west_1.id
  auto_accept               = true

  tags = {
    Name        = "${var.app_name}-us-east-1-to-eu-west-1-accepter"
    Application = var.app_name
  }
}

resource "aws_vpc_peering_connection" "af_south_1_to_eu_west_1" {
  provider    = aws.af_south_1
  vpc_id      = module.node_af_south_1.vpc_id
  peer_vpc_id = module.node_eu_west_1.vpc_id
  peer_region = "eu-west-1"
  auto_accept = false

  tags = {
    Name        = "${var.app_name}-af-south-1-to-eu-west-1"
    Application = var.app_name
  }
}

resource "aws_vpc_peering_connection_accepter" "af_south_1_to_eu_west_1" {
  provider                  = aws.eu_west_1
  vpc_peering_connection_id = aws_vpc_peering_connection.af_south_1_to_eu_west_1.id
  auto_accept               = true

  tags = {
    Name        = "${var.app_name}-af-south-1-to-eu-west-1-accepter"
    Application = var.app_name
  }
}

resource "aws_route" "us_east_1_to_af_south_1" {
  provider                  = aws.us_east_1
  route_table_id            = module.node_us_east_1.route_table_id
  destination_cidr_block    = var.af_south_1_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.us_east_1_to_af_south_1.id
}

resource "aws_route" "af_south_1_to_us_east_1" {
  provider                  = aws.af_south_1
  route_table_id            = module.node_af_south_1.route_table_id
  destination_cidr_block    = var.us_east_1_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.us_east_1_to_af_south_1.id
}

resource "aws_route" "us_east_1_to_eu_west_1" {
  provider                  = aws.us_east_1
  route_table_id            = module.node_us_east_1.route_table_id
  destination_cidr_block    = var.eu_west_1_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.us_east_1_to_eu_west_1.id
}

resource "aws_route" "eu_west_1_to_us_east_1" {
  provider                  = aws.eu_west_1
  route_table_id            = module.node_eu_west_1.route_table_id
  destination_cidr_block    = var.us_east_1_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.us_east_1_to_eu_west_1.id
}

resource "aws_route" "af_south_1_to_eu_west_1" {
  provider                  = aws.af_south_1
  route_table_id            = module.node_af_south_1.route_table_id
  destination_cidr_block    = var.eu_west_1_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.af_south_1_to_eu_west_1.id
}

resource "aws_route" "eu_west_1_to_af_south_1" {
  provider                  = aws.eu_west_1
  route_table_id            = module.node_eu_west_1.route_table_id
  destination_cidr_block    = var.af_south_1_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.af_south_1_to_eu_west_1.id
}
