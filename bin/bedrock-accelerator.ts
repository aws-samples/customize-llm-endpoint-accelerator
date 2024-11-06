#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BedrockAcceleratorStack } from '../lib/bedrock-accelerator-stack';
import * as fs from 'fs';
import * as path from 'path';

const app = new cdk.App();

// Read and parse .env file
function loadEnvFile(): { [key: string]: string } {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error('.env file not found. Please create one based on the template.');
  }

  const envContent = fs.readFileSync(envPath, 'utf-8');
  const env: { [key: string]: string } = {};

  envContent.split('\n').forEach(line => {
    // Skip comments and empty lines
    if (line.startsWith('#') || !line.trim()) return;
    
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      env[key.trim()] = valueParts.join('=').trim();
    }
  });

  return env;
}

// Load environment variables from .env file
const envVars = loadEnvFile();

// Get configuration values
const vpcId = envVars['VPC_ID'];
const publicSubnetIds = envVars['PUBLIC_SUBNET_IDS']?.split(',') || [];
const enableGlobalAccelerator = envVars['ENABLE_GLOBAL_ACCELERATOR']?.toLowerCase() === 'true';
const region = envVars['AWS_REGION'] || process.env.CDK_DEFAULT_REGION;
const nlbSecurityGroup = envVars['NLB_SECURITY_GROUP'];

if (!vpcId) {
  throw new Error('VPC_ID must be provided in .env file');
}

if (!publicSubnetIds || publicSubnetIds.length === 0) {
  throw new Error('PUBLIC_SUBNET_IDS must be provided in .env file');
}

if (!region) {
  throw new Error('AWS_REGION must be provided in .env file or CDK_DEFAULT_REGION must be set');
}

// Create the main Bedrock Accelerator stack
new BedrockAcceleratorStack(app, 'BedrockAcceleratorStack', {
  vpcId,
  publicSubnetIds,
  enableGlobalAccelerator,
  region,
  nlbSecurityGroup,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: region
  },
  description: 'Bedrock Accelerator Stack with VPC Endpoint and NLB'
});

app.synth();
