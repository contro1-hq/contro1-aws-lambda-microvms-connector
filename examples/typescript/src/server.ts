import crypto from 'node:crypto';
import express from 'express';
import dotenv from 'dotenv';
import { LambdaClient } from '@aws-sdk/client-lambda';
import * as Lambda from '@aws-sdk/client-lambda';

dotenv.config();

type Decision = 'auto_approve' | 'require_approval' | 'block';
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type ActionType =
  | 'run_microvm'
  | 'create_auth_token'
  | 'create_shell_token'
  | 'suspend'
  | 'resume'
  | 'terminate';

type MicrovmRequest = {
  action_type: ActionType;
  agent_id?: string;
  owner?: string;
  image_arn?: string;
  execution_role_arn?: string;
  microvm_id?: string;
  reason?: string;
  environment?: string;
  maximum_duration_seconds?: number;
  token_ttl_seconds?: number;
  ports?: number[];
  network?: { egress?: 'none' | 'internet' | 'vpc' | 'private' };
  shell_access?: boolean;
  correlation_id?: string;
  metadata?: Record<string, unknown>;
};

type PendingAction = {
  request_id: string;
  external_request_id: string;
  original: MicrovmRequest;
  awsInput: Record<string, unknown>;
};

type ProtocolRequest = {
  title: string;
  description?: string;
  request_type: 'approval' | 'input' | 'decision' | 'review';
  source: {
    integration: string;
    framework?: string;
    workflow_id?: string;
    run_id?: string;
    session_id?: string;
  };
  routing?: { required_role?: string; priority?: 'low' | 'normal' | 'high' | 'urgent'; sla_minutes?: number };
  actor?: { agent_id?: string; agent_name?: string; user_id?: string; user_email?: string };
  context?: {
    tool_name?: string;
    tool_input?: unknown;
    action_type?: string;
    resource?: string;
    environment?: string;
    summary?: string;
  };
  continuation: { mode: 'decision' | 'instruction'; callback_url?: string; webhook_url?: string; expires_at?: string };
  risk_level?: RiskLevel;
  policy_trigger?: string;
  policy_context?: {
    source?: string;
    policy_name?: string;
    rule_id?: string;
    rule_reason?: string;
    policy_version?: string;
    enforcement?: string;
  };
  approval_comment_required?: boolean;
  external_request_id?: string;
  correlation_id?: string;
  metadata?: Record<string, unknown>;
};

class Contro1Client {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    this.apiKey = process.env.CONTRO1_API_KEY || 'cc_missing_for_local_mock';
    this.baseUrl = (process.env.CONTRO1_BASE_URL || 'https://api.contro1.com/api/centcom/v1').replace(/\/$/, '');
  }

  async createProtocolRequest(payload: ProtocolRequest): Promise<Record<string, unknown>> {
    return await this.post('/requests', normalizeProtocolRequest(payload), payload.external_request_id);
  }

  async logAction(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.post('/audit-records', payload, String(payload.external_request_id || ''));
  }

  private async post(path: string, payload: unknown, idempotencyKey?: string): Promise<Record<string, unknown>> {
    if (this.apiKey === 'cc_missing_for_local_mock') {
      console.log(`SIMULATED Contro1 POST ${path}`, JSON.stringify(payload, null, 2));
      return { id: `req_${stableHash(payload)}`, state: 'simulated' };
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Contro1 API failed: ${response.status} ${JSON.stringify(body)}`);
    }
    return body;
  }
}

const EVENT = {
  runRequested: 'aws.microvm.run.requested',
  runApproved: 'aws.microvm.run.approved',
  runDenied: 'aws.microvm.run.denied',
  runCreated: 'aws.microvm.run.created',
  authTokenRequested: 'aws.microvm.auth_token.requested',
  authTokenIssued: 'aws.microvm.auth_token.issued',
  shellTokenRequested: 'aws.microvm.shell_token.requested',
  shellTokenApproved: 'aws.microvm.shell_token.approved',
  shellTokenDenied: 'aws.microvm.shell_token.denied',
  suspendRequested: 'aws.microvm.suspend.requested',
  resumeRequested: 'aws.microvm.resume.requested',
  terminateRequested: 'aws.microvm.terminate.requested',
  bypassDetected: 'aws.microvm.bypass.detected',
  unmanagedDetected: 'aws.microvm.unmanaged.detected',
} as const;

const port = Number(process.env.LISTENER_PORT || '8091');
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const simulateAws = (process.env.SIMULATE_AWS || 'true').toLowerCase() !== 'false';
const callbackMaxSkewSeconds = Number(process.env.CALLBACK_MAX_SKEW_SECONDS || '300');
const maxAutoApproveDurationSeconds = Number(process.env.MAX_AUTO_APPROVE_DURATION_SECONDS || '1800');
const maxTokenTtlSeconds = Number(process.env.MAX_TOKEN_TTL_SECONDS || '900');
const defaultRequiredRole = process.env.DEFAULT_REQUIRED_ROLE || 'security';
const defaultSlaMinutes = Number(process.env.DEFAULT_SLA_MINUTES || '10');

const allowedAgents = setFromEnv('ALLOWED_AGENT_IDS');
const allowedImages = setFromEnv('ALLOWED_IMAGE_ARNS');
const allowedRoles = setFromEnv('ALLOWED_EXECUTION_ROLE_ARNS');
const productionRoles = setFromEnv('PRODUCTION_EXECUTION_ROLE_ARNS');
const allowedPorts = new Set((process.env.ALLOWED_TOKEN_PORTS || '8080,8443').split(',').map((value) => Number(value.trim())).filter(Boolean));

const centcom = new Contro1Client();
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });
const pendingByRequestId = new Map<string, PendingAction>();
const pendingByExternalId = new Map<string, PendingAction>();

const app = express();
app.use(express.json({
  verify: (req, _res, buffer) => {
    (req as express.Request & { rawBody?: string }).rawBody = buffer.toString('utf8');
  },
}));

function setFromEnv(name: string): Set<string> {
  return new Set((process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean));
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function externalRequestId(input: MicrovmRequest): string {
  return [
    'aws-microvm',
    input.action_type,
    input.agent_id || 'unknown-agent',
    input.microvm_id || stableHash(input.image_arn || 'no-image'),
    stableHash({
      image_arn: input.image_arn,
      execution_role_arn: input.execution_role_arn,
      duration: input.maximum_duration_seconds,
      ports: input.ports,
      token_ttl_seconds: input.token_ttl_seconds,
      shell_access: input.shell_access,
    }),
  ].join(':');
}

function classify(input: MicrovmRequest): { decision: Decision; risk: RiskLevel; ruleId: string; reason: string } {
  if (!input.agent_id || !allowedAgents.has(input.agent_id)) {
    return { decision: 'block', risk: 'critical', ruleId: 'unknown-agent', reason: 'Unknown or unapproved agent cannot manage MicroVMs.' };
  }
  if (!input.owner && input.action_type === 'run_microvm') {
    return { decision: 'block', risk: 'critical', ruleId: 'missing-owner', reason: 'MicroVM launch requires an accountable owner.' };
  }
  if (input.action_type === 'run_microvm') {
    if (!input.image_arn || !allowedImages.has(input.image_arn)) {
      return { decision: 'require_approval', risk: 'high', ruleId: 'new-or-unapproved-image', reason: 'MicroVM image is not in the approved registry.' };
    }
    if (!input.execution_role_arn || !allowedRoles.has(input.execution_role_arn)) {
      return { decision: 'block', risk: 'critical', ruleId: 'unapproved-execution-role', reason: 'Execution role is missing or not constrained for MicroVM use.' };
    }
    if (productionRoles.has(input.execution_role_arn) && input.shell_access) {
      return { decision: 'block', risk: 'critical', ruleId: 'shell-plus-production', reason: 'Shell access with production execution role is blocked.' };
    }
    if (productionRoles.has(input.execution_role_arn)) {
      return { decision: 'require_approval', risk: 'high', ruleId: 'production-execution-role', reason: 'Production execution role requires human approval.' };
    }
    if (input.shell_access) {
      return { decision: 'require_approval', risk: 'high', ruleId: 'shell-requested', reason: 'Shell access always requires human approval.' };
    }
    if (input.network?.egress && input.network.egress !== 'none') {
      return { decision: 'require_approval', risk: 'high', ruleId: 'network-egress', reason: 'Internet, VPC, or private egress requires human approval.' };
    }
    if ((input.maximum_duration_seconds || 0) > maxAutoApproveDurationSeconds) {
      return { decision: 'require_approval', risk: 'medium', ruleId: 'long-duration', reason: 'Requested duration exceeds auto-approval limit.' };
    }
    return { decision: 'auto_approve', risk: 'low', ruleId: 'known-low-risk-launch', reason: 'Known agent, image, role, no shell, and short duration.' };
  }

  if (input.action_type === 'create_shell_token') {
    return { decision: 'require_approval', risk: 'high', ruleId: 'shell-token', reason: 'Shell token issuance always requires approval.' };
  }
  if (input.action_type === 'create_auth_token') {
    const ttl = input.token_ttl_seconds || 0;
    const ports = input.ports || [];
    const hasBroadPorts = ports.length === 0 || ports.some((port) => !allowedPorts.has(port));
    if (hasBroadPorts || ttl > maxTokenTtlSeconds) {
      return { decision: 'require_approval', risk: 'high', ruleId: 'broad-or-long-token', reason: 'Endpoint token is broad, unscoped, or long-lived.' };
    }
    return { decision: 'auto_approve', risk: 'low', ruleId: 'scoped-short-token', reason: 'Endpoint token is scoped to approved ports and short-lived.' };
  }
  if (input.action_type === 'terminate') {
    return { decision: 'auto_approve', risk: 'medium', ruleId: 'emergency-control', reason: 'Terminate is an emergency control and is audit logged.' };
  }
  return { decision: 'require_approval', risk: 'medium', ruleId: `${input.action_type}-review`, reason: `MicroVM ${input.action_type} requires review.` };
}

function awsInputFor(input: MicrovmRequest): Record<string, unknown> {
  if (input.action_type === 'run_microvm') {
    return {
      ImageIdentifier: input.image_arn,
      ExecutionRoleArn: input.execution_role_arn,
      MaximumDurationInSeconds: input.maximum_duration_seconds,
      RunHookPayload: {
        contro1_request_id: input.metadata?.contro1_request_id,
        agent_id: input.agent_id,
        owner: input.owner,
        correlation_id: input.correlation_id,
      },
    };
  }
  if (input.action_type === 'create_auth_token') {
    return {
      MicrovmId: input.microvm_id,
      Ports: input.ports,
      TimeToLiveInSeconds: input.token_ttl_seconds,
    };
  }
  if (input.action_type === 'create_shell_token') {
    return { MicrovmId: input.microvm_id, TimeToLiveInSeconds: input.token_ttl_seconds || 900 };
  }
  return { MicrovmId: input.microvm_id };
}

async function callAws(input: MicrovmRequest, awsInput: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (simulateAws) {
    return {
      simulated: true,
      action_type: input.action_type,
      microvm_id: input.microvm_id || `mvm_${stableHash(awsInput)}`,
      endpoint: input.action_type === 'run_microvm' ? `https://mvm-${stableHash(awsInput)}.lambda-microvm.local` : undefined,
      token: input.action_type.includes('token') ? `mock_token_${stableHash(awsInput)}` : undefined,
    };
  }

  const commandNames: Record<ActionType, string> = {
    run_microvm: 'RunMicrovmCommand',
    create_auth_token: 'CreateMicrovmAuthTokenCommand',
    create_shell_token: 'CreateMicrovmShellAuthTokenCommand',
    suspend: 'SuspendMicrovmCommand',
    resume: 'ResumeMicrovmCommand',
    terminate: 'TerminateMicrovmCommand',
  };
  const commandCtor = (Lambda as Record<string, unknown>)[commandNames[input.action_type]];
  if (typeof commandCtor !== 'function') {
    throw new Error(`Installed @aws-sdk/client-lambda does not expose ${commandNames[input.action_type]} yet. Upgrade AWS SDK or use SIMULATE_AWS=true.`);
  }
  const command = new (commandCtor as new (input: Record<string, unknown>) => unknown)(awsInput);
  return await lambda.send(command as never) as unknown as Record<string, unknown>;
}

async function logAction(action: string, summary: string, input: MicrovmRequest, outcome: 'success' | 'failure' = 'success', metadata?: Record<string, unknown>) {
  try {
    await centcom.logAction({
      action,
      summary,
      source: { integration: 'aws-lambda-microvms', workflow_id: 'microvm-launcher' },
      actor: { agent_id: input.agent_id },
      resource: { type: 'aws.lambda.microvm', id: input.microvm_id, uri: input.image_arn },
      outcome,
      severity: outcome === 'success' ? 'info' : 'warning',
      correlation_id: input.correlation_id,
      external_request_id: externalRequestId(input),
      metadata: { ...input.metadata, ...metadata },
    });
  } catch (error) {
    console.warn('Could not write Contro1 audit record:', error);
  }
}

function normalizeProtocolRequest(request: ProtocolRequest): Record<string, unknown> {
  return {
    type: request.request_type,
    context: request.context?.summary || request.description || request.title,
    question: request.title,
    callback_url: request.continuation.webhook_url || request.continuation.callback_url,
    priority: request.routing?.priority || 'normal',
    required_role: request.routing?.required_role,
    sla_minutes: request.routing?.sla_minutes,
    risk_level: request.risk_level,
    policy_trigger: request.policy_trigger,
    policy_context: request.policy_context,
    approval_comment_required: request.approval_comment_required,
    metadata: {
      protocol_request: request,
      ...request.metadata,
    },
    external_request_id: request.external_request_id,
    correlation_id: request.correlation_id,
  };
}

async function createApproval(input: MicrovmRequest, awsInput: Record<string, unknown>, policy: ReturnType<typeof classify>) {
  const extId = externalRequestId(input);
  const duplicate = pendingByExternalId.get(extId);
  if (duplicate) {
    return { status: 'pending_approval', request_id: duplicate.request_id, external_request_id: extId, duplicate: true };
  }

  const created = await centcom.createProtocolRequest({
    title: `Approve AWS Lambda MicroVM action: ${input.action_type}`,
    description: policy.reason,
    request_type: 'approval',
    source: {
      integration: 'aws-lambda-microvms',
      framework: 'aws-lambda',
      workflow_id: 'microvm-launcher',
      run_id: extId,
    },
    routing: { required_role: defaultRequiredRole, priority: policy.risk === 'critical' || policy.risk === 'high' ? 'urgent' : 'normal', sla_minutes: defaultSlaMinutes },
    actor: { agent_id: input.agent_id },
    context: {
      action_type: input.action_type,
      resource: input.image_arn || input.microvm_id,
      environment: input.environment || 'sandbox',
      summary: input.reason || policy.reason,
      tool_input: awsInput,
    },
    continuation: { mode: 'decision', webhook_url: `${publicBaseUrl}/contro1/callback` },
    risk_level: policy.risk,
    policy_trigger: policy.reason,
    policy_context: {
      source: 'aws_lambda_microvms_connector',
      policy_name: 'microvm-launcher-policy',
      rule_id: policy.ruleId,
      rule_reason: policy.reason,
      enforcement: 'require_approval',
    },
    approval_comment_required: policy.risk === 'high' || policy.risk === 'critical' || input.action_type === 'create_shell_token',
    external_request_id: extId,
    correlation_id: input.correlation_id || input.microvm_id || input.agent_id,
    metadata: { awsInput },
  });

  const requestId = String((created as Record<string, unknown>).id || (created as Record<string, unknown>).request_id || '');
  const pending = { request_id: requestId, external_request_id: extId, original: input, awsInput };
  pendingByRequestId.set(requestId, pending);
  pendingByExternalId.set(extId, pending);
  return { status: 'pending_approval', request_id: requestId, external_request_id: extId };
}

async function handleAction(input: MicrovmRequest) {
  const policy = classify(input);
  const awsInput = awsInputFor(input);
  const requestedEvent = input.action_type === 'run_microvm' ? EVENT.runRequested
    : input.action_type === 'create_auth_token' ? EVENT.authTokenRequested
    : input.action_type === 'create_shell_token' ? EVENT.shellTokenRequested
    : input.action_type === 'suspend' ? EVENT.suspendRequested
    : input.action_type === 'resume' ? EVENT.resumeRequested
    : EVENT.terminateRequested;
  await logAction(requestedEvent, policy.reason, input, 'success', { policy });

  if (policy.decision === 'block') {
    await logAction(input.action_type === 'run_microvm' ? EVENT.runDenied : `${requestedEvent}.blocked`, policy.reason, input, 'failure', { policy });
    return { status: 'blocked', policy };
  }
  if (policy.decision === 'require_approval') {
    return await createApproval(input, awsInput, policy);
  }
  const aws = await callAws(input, awsInput);
  const actionEvent = input.action_type === 'run_microvm' ? EVENT.runCreated
    : input.action_type === 'create_auth_token' ? EVENT.authTokenIssued
    : requestedEvent;
  await logAction(actionEvent, `AWS Lambda MicroVM action ${input.action_type} completed.`, input, 'success', { aws, policy });
  return { status: 'approved', decision: 'auto_approved', aws };
}

app.post('/microvms/run-request', async (req, res, next) => {
  try {
    res.json(await handleAction({ ...req.body, action_type: 'run_microvm' }));
  } catch (error) {
    next(error);
  }
});

app.post('/microvms/:microvm_id/auth-token-request', async (req, res, next) => {
  try {
    res.json(await handleAction({ ...req.body, microvm_id: req.params.microvm_id, action_type: 'create_auth_token' }));
  } catch (error) {
    next(error);
  }
});

app.post('/microvms/:microvm_id/shell-token-request', async (req, res, next) => {
  try {
    res.json(await handleAction({ ...req.body, microvm_id: req.params.microvm_id, action_type: 'create_shell_token' }));
  } catch (error) {
    next(error);
  }
});

for (const action of ['suspend', 'resume', 'terminate'] as const) {
  app.post(`/microvms/:microvm_id/${action}`, async (req, res, next) => {
    try {
      res.json(await handleAction({ ...req.body, microvm_id: req.params.microvm_id, action_type: action }));
    } catch (error) {
      next(error);
    }
  });
}

app.post('/discovery/unmanaged', async (req, res, next) => {
  try {
    const payload = req.body || {};
    await logAction(
      payload.bypass ? EVENT.bypassDetected : EVENT.unmanagedDetected,
      payload.summary || 'Detected unmanaged or bypassed AWS Lambda MicroVM activity.',
      { action_type: 'run_microvm', agent_id: payload.agent_id || 'unknown', microvm_id: payload.microvm_id, correlation_id: payload.correlation_id },
      'failure',
      payload,
    );
    res.json({ status: 'logged' });
  } catch (error) {
    next(error);
  }
});

app.post('/contro1/callback', async (req, res, next) => {
  try {
    const rawBody = (req as express.Request & { rawBody?: string }).rawBody || '';
    if (!verifyCallback(rawBody, req.headers['x-centcom-signature'], req.headers['x-centcom-timestamp'])) {
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    const payload = req.body || {};
    const requestId = String(payload.request_id || payload.protocol_response?.request_id || '');
    const status = String(payload.status || payload.protocol_response?.status || '');
    const pending = pendingByRequestId.get(requestId);
    if (!pending) {
      res.status(404).json({ error: 'unknown_request_id' });
      return;
    }

    if (status !== 'approved') {
      const eventName = pending.original.action_type === 'create_shell_token' ? EVENT.shellTokenDenied : EVENT.runDenied;
      await logAction(eventName, `Contro1 denied or closed ${pending.original.action_type}: ${status}`, pending.original, 'failure', { callback: payload });
      res.json({ status: 'denied', request_id: requestId });
      return;
    }

    const aws = await callAws(pending.original, pending.awsInput);
    const eventName = pending.original.action_type === 'run_microvm' ? EVENT.runCreated
      : pending.original.action_type === 'create_auth_token' ? EVENT.authTokenIssued
      : pending.original.action_type === 'create_shell_token' ? EVENT.shellTokenApproved
      : `${pending.original.action_type}.approved`;
    await logAction(eventName, `Approved AWS Lambda MicroVM action ${pending.original.action_type} completed.`, pending.original, 'success', { callback: payload, aws });
    pendingByRequestId.delete(requestId);
    pendingByExternalId.delete(pending.external_request_id);
    res.json({ status: 'executed', request_id: requestId, aws });
  } catch (error) {
    next(error);
  }
});

function verifyCallback(rawBody: string, signatureHeader: string | string[] | undefined, timestampHeader: string | string[] | undefined): boolean {
  const secret = process.env.CONTRO1_WEBHOOK_SECRET || '';
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  if (!secret || !signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > callbackMaxSkewSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: error.message });
});

app.listen(port, () => {
  console.log(`Contro1 AWS Lambda MicroVMs connector listening on :${port}`);
  console.log(`SIMULATE_AWS=${simulateAws}`);
});
