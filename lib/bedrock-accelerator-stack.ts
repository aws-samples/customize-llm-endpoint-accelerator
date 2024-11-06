import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { GlobalAcceleratorNestedStack } from './global-accelerator-stack';
import { Construct } from 'constructs';
import * as cr from 'aws-cdk-lib/custom-resources';

export interface BedrockAcceleratorStackProps extends cdk.StackProps {
  vpcId: string;
  publicSubnetIds: string[];
  enableGlobalAccelerator?: boolean;
  region: string;  // Add region property
  nlbSecurityGroup: string;
}

export class BedrockAcceleratorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BedrockAcceleratorStackProps) {
    super(scope, id, props);

    // Import existing VPC
    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {
      vpcId: props.vpcId
    });

    // Get subnet information
    const subnets = props.publicSubnetIds.map((subnetId, index) => 
      ec2.Subnet.fromSubnetId(this, `Subnet${index}`, subnetId)
    );

    // Create security group for the VPC endpoint
    const securityGroup = new ec2.SecurityGroup(this, 'BedrockEndpoint/SecurityGroup', {
      vpc,
      description: 'Security group for Bedrock endpoint',
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from VPC'
    );

    // Create security group for the nlb
    const nlbSecurityGroup = new ec2.SecurityGroup(this, 'BedrockNLB/SecurityGroup', {
      vpc,
      description: 'Security group for Bedrock NLB',
      allowAllOutbound: true,
    });

    nlbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.nlbSecurityGroup),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic for Bedrock NLB'
    );

    // Create VPC endpoint for Bedrock
    const endpoint = new ec2.InterfaceVpcEndpoint(this, 'BedrockEndpoint', {
      vpc,
      service: {
        name: `com.amazonaws.${props.region}.bedrock-runtime`, 
        port: 443,
      },
      subnets: {
        subnets: [subnets[0]] // 只使用第一个子网
      },
      securityGroups: [securityGroup],
      privateDnsEnabled: false // 禁用私有 DNS
    });

    // Create EIP for NLB
    const eip = new ec2.CfnEIP(this, 'NlbEip', {
      domain: 'vpc',
      tags: [{
        key: 'Name',
        value: 'BedrockAccelerator-NLB-EIP'
      }]
    });

    // Create Network Load Balancer with specific subnet mapping and EIP
    const cfnNlb = new elbv2.CfnLoadBalancer(this, 'BedrockNLB', {
      type: 'network',
      scheme: 'internet-facing',
      securityGroups: [nlbSecurityGroup.securityGroupId],
      subnetMappings: [
        {
          subnetId: subnets[0].subnetId,
          allocationId: eip.attrAllocationId
        }
      ]
    });

    // Create NLB from the CfnLoadBalancer
    const nlb = elbv2.NetworkLoadBalancer.fromNetworkLoadBalancerAttributes(this, 'BedrockNLBFromCfn', {
      loadBalancerArn: cfnNlb.ref,
      loadBalancerDnsName: cfnNlb.attrDnsName,
      vpc
    });

    // Create target group
    const targetGroup = new elbv2.NetworkTargetGroup(this, 'BedrockTargetGroup', {
      vpc,
      port: 443,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        enabled: true,
        protocol: elbv2.Protocol.TCP,
      },
    });

    // Create a custom resource to get VPC endpoint network interface IPs
    const getEndpointInfo = new cr.AwsCustomResource(this, 'GetEndpointInfo', {
      onCreate: {
        service: 'EC2',
        action: 'describeVpcEndpoints',
        parameters: {
          VpcEndpointIds: [endpoint.vpcEndpointId]
        },
        physicalResourceId: cr.PhysicalResourceId.of(endpoint.vpcEndpointId),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE
      })
    });

    // Add dependency to ensure endpoint is created first
    getEndpointInfo.node.addDependency(endpoint);

    // Second custom resource to get network interface IP
    const getNetworkInterfaceInfo = new cr.AwsCustomResource(this, 'GetNetworkInterfaceInfo', {
      onCreate: {
        service: 'EC2',
        action: 'describeNetworkInterfaces',
        parameters: {
          NetworkInterfaceIds: [getEndpointInfo.getResponseField('VpcEndpoints.0.NetworkInterfaceIds.0')]
        },
        physicalResourceId: cr.PhysicalResourceId.of('NetworkInterface'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE
      })
    });

    // Add dependency to ensure we get endpoint info first
    getNetworkInterfaceInfo.node.addDependency(getEndpointInfo);

    // Create a custom resource to register targets
    new cr.AwsCustomResource(this, 'RegisterTargets', {
      onCreate: {
        service: 'ELBv2',
        action: 'registerTargets',
        parameters: {
          TargetGroupArn: targetGroup.targetGroupArn,
          Targets: [{
            Id: getNetworkInterfaceInfo.getResponseField('NetworkInterfaces.0.PrivateIpAddress'),
            Port: 443
          }]
        },
        physicalResourceId: cr.PhysicalResourceId.of('RegisterTargets'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE
      })
    });

    // Add listener to NLB
    new elbv2.CfnListener(this, 'BedrockListener', {
      defaultActions: [{
        type: 'forward',
        targetGroupArn: targetGroup.targetGroupArn
      }],
      loadBalancerArn: nlb.loadBalancerArn,
      port: 443,
      protocol: 'TCP'
    });

    // Create Global Accelerator if enabled
    if (props.enableGlobalAccelerator !== false) {
      const globalAcceleratorStack = new GlobalAcceleratorNestedStack(this, 'GlobalAcceleratorStack', {
        nlbArn: nlb.loadBalancerArn,
        nlbRegion: props.region,  // Use props.region
      });

      // Export Global Accelerator outputs
      new cdk.CfnOutput(this, 'GlobalAcceleratorDnsName', {
        value: globalAcceleratorStack.accelerator.attrDnsName,
      });

      new cdk.CfnOutput(this, 'GlobalAcceleratorArn', { 
        value: globalAcceleratorStack.accelerator.ref
      });
    }

    // Output the NLB DNS name
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: nlb.loadBalancerDnsName,
    });

    // Output the NLB ARN
    new cdk.CfnOutput(this, 'LoadBalancerArn', {
      value: nlb.loadBalancerArn,
    });

    // Output the VPC endpoint ID
    new cdk.CfnOutput(this, 'VpcEndpointId', {
      value: endpoint.vpcEndpointId,
    });

    // Output the EIP
    new cdk.CfnOutput(this, 'ElasticIp', {
      value: eip.ref,
    });
  }
}
