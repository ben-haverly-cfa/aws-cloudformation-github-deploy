import * as path from 'path'
import * as core from '@actions/core'
import * as aws from 'aws-sdk'
import * as fs from 'fs'
import { deployStack, getStackOutputs } from './deploy'
import {
  isUrl,
  parseTags,
  parseString,
  parseNumber,
  parseARNs,
  parseParameters
} from './utils'

import type { CloudFormation } from 'aws-sdk'
import type { CreateStackInput } from 'aws-sdk/clients/cloudformation'

export type InputCapabilities =
  | 'CAPABILITY_IAM'
  | 'CAPABILITY_NAMED_IAM'
  | 'CAPABILITY_AUTO_EXPAND'

// The custom client configuration for the CloudFormation clients.
const CUSTOM_USER_AGENT = 'aws-cloudformation-github-deploy-for-github-actions'

const createBucketName: () => Promise<string> =
async () => {
  return new aws.STS()
  .getCallerIdentity()
  .promise()
  .then(data =>`${data.Account}-us-east-1-deploy`)
}

/**
 * Take a local template file path and upload it to S3, returning location of
 * uploaded file
 */
const uploadTemplate: (stackName: string, template: string) => Promise<string> =
async (stackName, template) => {
  core.debug('Uploading CFN template to S3');

  const { GITHUB_WORKSPACE = __dirname } = process.env;

  const templateFilePath = path.isAbsolute(template)
    ? template
    : path.join(GITHUB_WORKSPACE, template);

  const Body = fs.readFileSync(templateFilePath, 'utf8');

  const Bucket = await createBucketName();

  const s3 = new aws.S3()
  await s3.createBucket({ Bucket }).promise()

  const uploadResp = await s3
    .upload({
      Bucket,
      Body,
      Key: `${stackName}/cloudformation.yaml`
    })
    .promise()

  return uploadResp.Location
};


const buildCfn: () => CloudFormation =
() => {
  const region = core.getInput('region', { required: false });

  if (region.length > 0) {
    return new aws.CloudFormation({
      customUserAgent: CUSTOM_USER_AGENT,
      region: region
    });
  }

  return new aws.CloudFormation({ customUserAgent: CUSTOM_USER_AGENT });
}

export async function run(): Promise<void> {
  try {
    const stackName = core.getInput('name', { required: true })
    const capabilities = core.getInput('capabilities', { required: false })
    const parameterOverrides = core.getInput('parameter-overrides', { required: false })
    const noEmptyChangeSet = !!+core.getInput('no-fail-on-empty-changeset', { required: false })
    const noExecuteChageSet = !!+core.getInput('no-execute-changeset', { required: false })
    const noDeleteFailedChangeSet = !!+core.getInput('no-delete-failed-changeset', { required: false })
    const disableRollback = !!+core.getInput('disable-rollback', { required: false })
    const timeoutInMinutes = parseNumber(core.getInput('timeout-in-minutes', { required: false }))
    const notificationARNs = parseARNs(core.getInput('notification-arns', { required: false }))
    const roleARN = parseString( core.getInput('role-arn', { required: false }) )
    const tags = parseTags( core.getInput('tags', { required: false }) )
    const terminationProtections = !!+core.getInput('termination-protection', { required: false })
    const template = core.getInput('template', { required: true });

    const templateURL = isUrl(template) ? template : await uploadTemplate(stackName, template);
    const parameters = parameterOverrides ? parseParameters(parameterOverrides.trim()) : undefined;

    const params: CreateStackInput = {
      StackName: stackName,
      Capabilities: capabilities.split(',').map(cap => cap.trim()),
      RoleARN: roleARN,
      NotificationARNs: notificationARNs,
      DisableRollback: disableRollback,
      TimeoutInMinutes: timeoutInMinutes,
      TemplateURL: templateURL,
      Tags: tags,
      EnableTerminationProtection: terminationProtections,
      Parameters: parameters,
    }


    const cfn = buildCfn();
    const stackId = await deployStack(
      cfn,
      params,
      noEmptyChangeSet,
      noExecuteChageSet,
      noDeleteFailedChangeSet
    )
    core.setOutput('stack-id', stackId || 'UNKNOWN')

    if (stackId) {
      const outputs = await getStackOutputs(cfn, stackId)
      for (const [key, value] of outputs) {
        core.setOutput(key, value)
      }
    }
  } catch (err) {
    core.setFailed(err.message)
    core.debug(err.stack)
  }
}

/* istanbul ignore next */
if (require.main === module) {
  run()
}
