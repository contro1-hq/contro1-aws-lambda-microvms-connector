# AWS Lambda MicroVMs Connector Guide

This guide defines a governed launcher and token broker for AWS Lambda MicroVMs using Contro1.

## Core Positioning

AWS Lambda MicroVMs isolate AI-generated code. Contro1 governs the decision to run it.

The connector sits before AWS:

```text
Agent / app / internal runtime
        |
        v
Contro1 AWS Lambda MicroVMs Connector
        |
        v
Contro1 approval, routing, and audit evidence
        |
        v
AWS Lambda MicroVM APIs
```

The connector is intentionally not a runtime shim in the first release. It controls the lifecycle and access surfaces that happen before or around execution:

- launch
- endpoint token
- shell token
- suspend
- resume
- terminate

## What Is A MicroVM?

A MicroVM is a small, fast virtual machine built for isolated execution. AWS Lambda MicroVMs are useful for workloads such as AI sandboxes, coding agents, vulnerability scanners, CI/CD executors, user-submitted code, and notebook sessions.

The useful property is VM-level isolation with serverless lifecycle control. The risk is that isolation does not decide whether the action should happen, who owns it, or how much access the running sandbox should receive.

## Governance Boundary

Use three layers:

- **Launcher**: governs whether a MicroVM may run.
- **Token broker**: governs who can reach the endpoint, which ports are allowed, and how long access lasts.
- **Runtime shim**: later governs what the agent does after it starts.

This first connector focuses on the launcher and token broker layers.

## Request Flow

### Run MicroVM

1. Agent calls `POST /microvms/run-request`.
2. Connector classifies the request.
3. If blocked, no AWS call is made and an audit record is written.
4. If approval is required, connector creates a Contro1 request and waits for signed callback.
5. If approved, connector calls `RunMicrovm`.
6. Connector logs `aws.microvm.run.created`.

### Auth Token

1. Client calls `POST /microvms/:microvm_id/auth-token-request`.
2. Connector checks port scope, expiry, agent, owner, and environment.
3. Broad or long-lived tokens require approval.
4. Approved token requests call `CreateMicrovmAuthToken`.

### Shell Token

Shell access is high-risk and always requires approval.

1. Client calls `POST /microvms/:microvm_id/shell-token-request`.
2. Connector creates Contro1 request with `approval_comment_required: true`.
3. Approved callback calls `CreateMicrovmShellAuthToken`.

### Lifecycle Controls

Suspend, resume, and terminate are controlled actions. Emergency terminate may be allowed to trusted operators while still writing evidence.

## Setup Responsibilities

There are three moving parts.

```text
Your agent
  calls
This connector
  asks for approval from
Contro1
  sends a signed answer back to
This connector
  then calls
AWS Lambda MicroVMs
```

Contro1 owns approval routing, signed approval responses, and audit evidence. The connector is the server from this repo: it owns the policy check and the AWS call. AWS owns the MicroVM image, IAM roles, lifecycle APIs, endpoint tokens, shell tokens, and cloud logs.

### Prepare In Contro1

Create the operational control layer first:

- Contro1 account and organization.
- Open **Settings -> APIs & Webhooks**.
- Create an API key named something like `Lambda MicroVMs connector`.
- Store that key in the deployed server environment as `CONTRO1_API_KEY`.
- Reveal or rotate the organization webhook secret.
- Store that secret in the deployed server environment as `CONTRO1_WEBHOOK_SECRET`.
- Configure where approval requests go: dashboard, Slack, Teams, departments, roles, SLA, and escalation.
- Decide which reviewer role should handle high-risk MicroVM requests, such as `security`, `platform`, or `cloud-admin`.

Contro1 does not need AWS root access. The deployed server from this repo should use a dedicated AWS role, and Contro1 should receive enough metadata to make approval and audit decisions.

### Prepare The Deployed Server

Run one of the example servers in this repository:

- TypeScript/Express: `examples/typescript/src/server.ts`
- Python/Flask: `examples/python/app.py`

This server is the bridge between Contro1 and AWS. It can run on Cloud Run, ECS, Fly.io, Render, a VM, Kubernetes, or any HTTPS service host.

The approval loop works like this:

1. An agent asks this server to launch a MicroVM or create a token.
2. The server decides whether this can run automatically, must ask a human, or must be blocked.
3. If a human must approve, the server creates a Contro1 request.
4. The server includes the address where Contro1 should send the answer: `PUBLIC_BASE_URL + /contro1/callback`.
5. A person approves or denies in Contro1, Slack, or Teams.
6. Contro1 sends a signed POST back to this server.
7. The server verifies the signature.
8. Only then does the server call `RunMicrovm`, `CreateMicrovmAuthToken`, or another AWS action.

Required server environment:

```bash
CONTRO1_API_KEY=cc_live_...
CONTRO1_WEBHOOK_SECRET=whsec_...
PUBLIC_BASE_URL=https://your-connector-host.example.com
```

Run the TypeScript example locally:

```bash
cd examples/typescript
npm install
npm run dev
```

Run the Python example locally:

```bash
cd examples/python
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Example:

```bash
PUBLIC_BASE_URL=https://microvms.example.com
```

The connector exposes:

```text
POST https://microvms.example.com/contro1/callback
```

That route is where Contro1 sends the signed approval result back to the server.

Policy for this server is configured in environment variables or deployment config:

- `ALLOWED_AGENT_IDS`
- `ALLOWED_IMAGE_ARNS`
- `ALLOWED_EXECUTION_ROLE_ARNS`
- `PRODUCTION_EXECUTION_ROLE_ARNS`
- `ALLOWED_TOKEN_PORTS`
- `MAX_AUTO_APPROVE_DURATION_SECONDS`
- `MAX_TOKEN_TTL_SECONDS`

For local testing, use `SIMULATE_AWS=true`. If you want to test real approval answers from Contro1 while developing locally, expose the local server with a tunnel and set `PUBLIC_BASE_URL` to the tunnel URL.

### Prepare In AWS

Create the cloud execution surface:

- Confirm Lambda MicroVMs availability in the target region.
- Build or select the MicroVM image that agents may run.
- Create a dedicated IAM principal for the Contro1 connector/launcher.
- Grant the connector only the MicroVM actions it needs:
  - `lambda:RunMicrovm`
  - `lambda:GetMicrovm`
  - `lambda:ListMicrovms`
  - `lambda:SuspendMicrovm`
  - `lambda:ResumeMicrovm`
  - `lambda:TerminateMicrovm`
  - `lambda:CreateMicrovmAuthToken`
  - `lambda:CreateMicrovmShellAuthToken` only if shell is allowed
- Create constrained execution roles for MicroVM workloads.
- Remove direct lifecycle/token permissions from agents, developers, and CI roles that should be governed.
- Enable CloudTrail for MicroVM API activity to detect direct AWS calls outside Contro1.
- Enable CloudWatch/runtime logs if you need stdout/stderr or application-level evidence.
- Use tags or `runHookPayload` metadata for `contro1_request_id`, agent id, owner, environment, and correlation id.

### Local vs Production Mode

Use `SIMULATE_AWS=true` while evaluating the repo, testing policy behavior, and verifying Contro1 approval callbacks.

Use `SIMULATE_AWS=false` only when:

- the AWS account and region support Lambda MicroVMs
- the connector IAM role is configured
- approved image ARNs and execution role ARNs are known
- CloudTrail/logging decisions are made
- the installed AWS SDK or boto3 version exposes the MicroVM APIs

With mock mode, the connector proves the Contro1 workflow. With production mode, it also calls AWS.

## Protocol Mapping

Use Contro1 Integration Protocol v1:

```json
{
  "title": "Approve AWS Lambda MicroVM launch?",
  "request_type": "approval",
  "source": {
    "integration": "aws-lambda-microvms",
    "framework": "aws-lambda",
    "workflow_id": "microvm-launcher",
    "run_id": "aws-microvm:run:req_123"
  },
  "context": {
    "action_type": "run_microvm",
    "resource": "arn:aws:lambda:us-east-1:123456789012:microvm-image:agent-sandbox",
    "environment": "production",
    "summary": "Agent agent-prod requests Lambda MicroVM launch with internet egress"
  },
  "continuation": {
    "mode": "decision",
    "webhook_url": "https://connector.example.com/contro1/callback"
  },
  "risk_level": "high",
  "policy_trigger": "MicroVM launch requires approval because internet egress or production role was requested.",
  "policy_context": {
    "source": "aws_lambda_microvms_connector",
    "policy_name": "microvm-launch-policy",
    "rule_id": "production-or-network-access",
    "rule_reason": "Production role or risky network mode requires approval",
    "enforcement": "require_approval"
  },
  "approval_comment_required": true,
  "external_request_id": "aws-microvm:run:agent-prod:image-hash:duration",
  "correlation_id": "session_123"
}
```

## Bypass Prevention

Contro1 must be the only principal allowed to call high-risk MicroVM lifecycle and token APIs.

IAM target:

- connector role can call MicroVM lifecycle/token APIs.
- agent roles cannot call lifecycle/token APIs directly.
- developer roles cannot issue shell tokens directly.
- CloudTrail data events are enabled for MicroVM actions.

Operational rule:

- Direct `RunMicrovm` outside Contro1 creates `aws.microvm.bypass.detected`.
- MicroVM without `contro1_request_id` creates `aws.microvm.unmanaged.detected`.
- Runtime shim can refuse startup if required Contro1 session metadata is missing.

## Unmanaged MicroVM Discovery

Production deployments should list AWS MicroVMs and images and identify:

- MicroVMs without `contro1_request_id`.
- images without owner.
- active sessions with shell enabled.
- active sessions using broad or long-lived tokens.
- production execution roles.
- risky network modes such as internet or private VPC access.

This gives Contro1 a product message beyond launch approvals:

> Discover unmanaged AI execution sandboxes before they become production risk.

## Dashboard Fields

| Field | Why it matters |
| --- | --- |
| MicroVM ID | AWS runtime identity |
| Agent ID | Who launched it |
| Owner | Who is accountable |
| Image | What code/runtime is running |
| Execution role | What cloud permissions it has |
| Network mode | internet / VPC / none |
| Shell enabled | High-risk access |
| Token scope | ports and expiry |
| Duration | Abuse, cost, and risk |
| Approval status | governed / pending / denied |
| Evidence status | audit-ready / missing |
| Emergency terminate | Immediate control |

## Event Taxonomy

```text
aws.microvm.run.requested
aws.microvm.run.approved
aws.microvm.run.denied
aws.microvm.run.created
aws.microvm.auth_token.requested
aws.microvm.auth_token.issued
aws.microvm.shell_token.requested
aws.microvm.shell_token.approved
aws.microvm.shell_token.denied
aws.microvm.suspend.requested
aws.microvm.resume.requested
aws.microvm.terminate.requested
aws.microvm.bypass.detected
aws.microvm.unmanaged.detected
```

## Production Checklist

- Use HTTPS for `PUBLIC_BASE_URL`.
- Store action state in durable storage, not memory.
- Verify Contro1 signed callbacks before any AWS continuation.
- Use deterministic idempotency keys.
- Enable CloudTrail data events for MicroVM APIs.
- Keep endpoint tokens short-lived and scoped by port.
- Require approval for shell access.
- Deny by default on timeout, invalid callback, missing owner, or unknown agent.
- Emit structured logs with request id, correlation id, AWS account, region, image, execution role, microvm id, and policy decision.

## Runtime Shim: Next Unlock

The launcher governs whether a MicroVM may run.

The runtime shim governs what the agent does after it starts:

- bash commands
- file reads/writes
- network calls
- package installs
- secret access
- dangerous tool calls

Without shim/tool instrumentation, Contro1 can suspend or terminate the MicroVM, but it cannot cleanly stop a specific command already running inside the VM.
