import * as cdk from 'aws-cdk-lib';
import * as globalaccelerator from 'aws-cdk-lib/aws-globalaccelerator';
import { NestedStack, NestedStackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface GlobalAcceleratorNestedStackProps extends NestedStackProps {
  nlbArn: string;
  nlbRegion: string;
}

export class GlobalAcceleratorNestedStack extends NestedStack {
  public readonly accelerator: globalaccelerator.CfnAccelerator;
  constructor(scope: Construct, id: string, props: GlobalAcceleratorNestedStackProps) {
    super(scope, id, props);

    // Create Global Accelerator
    this.accelerator = new globalaccelerator.CfnAccelerator(this, 'BedrockAccelerator', {
      name: 'bedrock-accelerator',
      enabled: true,
      ipAddressType: 'IPV4'
    });

    // Create listener
    const listener = new globalaccelerator.CfnListener(this, 'AcceleratorListener', {
      acceleratorArn: this.accelerator.ref,
      portRanges: [
        {
          fromPort: 443,
          toPort: 443
        }
      ],
      protocol: 'TCP'
    });

    // Create endpoint group
    new globalaccelerator.CfnEndpointGroup(this, 'EndpointGroup', {
      listenerArn: listener.ref,
      endpointGroupRegion: props.nlbRegion,
      endpointConfigurations: [
        {
          endpointId: props.nlbArn,
          weight: 100,
          clientIpPreservationEnabled: false
        }
      ]
    });

    // Output the Global Accelerator DNS name
    new cdk.CfnOutput(this, 'GlobalAcceleratorDNS', {
      value: this.accelerator.attrDnsName,
      description: 'The DNS name of the Global Accelerator'
    });
    // Output the Global Accelerator ARN
    new cdk.CfnOutput(this, 'GlobalAcceleratorARN', {
      value: this.accelerator.ref,
      description: 'The ARN of the Global Accelerator'
    });
  }
}
