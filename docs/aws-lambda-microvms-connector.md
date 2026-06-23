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

MVP scope is launcher and token broker.

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

Product phase should list AWS MicroVMs and images and identify:

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
